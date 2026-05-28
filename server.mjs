import http from 'http';
import https from 'https';

const VERIFY_TOKEN  = process.env.FB_VERIFY_TOKEN  || 'vmg_leads_2026';
const FB_TOKEN      = process.env.FB_SYSTEM_TOKEN;
const TG_BOT        = process.env.TG_BOT_TOKEN;
const TG_CHAT       = process.env.TG_CHAT_ID;
const TELNYX_KEY    = process.env.TELNYX_API_KEY;
const TELNYX_FROM   = process.env.TELNYX_FROM      || '+17813276498';
const PORT          = process.env.PORT              || 3000;

function fetchLead(leadId) {
  return new Promise((resolve, reject) => {
    https.get(
      `https://graph.facebook.com/v25.0/${leadId}?fields=id,created_time,field_data&access_token=${FB_TOKEN}`,
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }
    ).on('error', reject);
  });
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }));
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.end(body);
  });
}

function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return raw.startsWith('+') ? `+${digits}` : `+${digits}`;
}

function sendSMS(to, text) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ from: TELNYX_FROM, to, text }));
    const req = https.request({
      hostname: 'api.telnyx.com',
      path: '/v2/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Authorization': `Bearer ${TELNYX_KEY}`,
      },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      res.writeHead(200); res.end(challenge);
      console.log('Webhook verified by Facebook');
    } else {
      res.writeHead(403); res.end('Forbidden');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      res.writeHead(200); res.end('OK');
      try {
        const payload = JSON.parse(body);
        for (const entry of payload.entry || []) {
          for (const change of entry.changes || []) {
            if (change.field !== 'leadgen') continue;

            const leadId = change.value.leadgen_id;
            console.log(`New lead: ${leadId}`);

            const lead = await fetchLead(leadId);
            if (lead.error) { console.error('Fetch error:', lead.error.message); continue; }

            const fields = {};
            for (const f of lead.field_data || []) fields[f.name] = f.values?.[0] ?? '';

            const fullName  = fields['full_name'] || `${fields['first_name'] ?? ''} ${fields['last_name'] ?? ''}`.trim() || 'Unknown';
            const firstName = fields['first_name'] || fullName.split(' ')[0] || 'there';
            const phone     = fields['phone_number'] || fields['phone'] || '';
            const email     = fields['email'] || 'N/A';
            const time      = new Date(lead.created_time).toLocaleString('en-US', { timeZone: 'America/New_York' });

            // Telegram — notify Mido
            const tgMsg =
              `🔔 <b>NEW LEAD — VMG AI Receptionist</b>\n\n` +
              `👤 <b>${fullName}</b>\n` +
              `📞 <b>${phone || 'N/A'}</b>\n` +
              `📧 ${email}\n\n` +
              `🕐 ${time} ET\n\n` +
              `<i>Call within 5 minutes — warm leads convert 4x better</i>`;

            const tg = await sendTelegram(tgMsg);
            if (tg.ok) console.log(`Telegram sent for lead ${leadId}`);
            else console.error('Telegram error:', JSON.stringify(tg));

            // SMS — fire to the lead immediately
            const e164 = phone ? normalizePhone(phone) : null;
            if (e164) {
              const smsText = `Hey ${firstName}! You just requested a free VMG AI Receptionist demo — we're calling you in the next few minutes. Talk soon!`;
              try {
                const sms = await sendSMS(e164, smsText);
                if (sms.data?.id) console.log(`SMS sent to ${e164} for lead ${leadId}`);
                else console.error('SMS error:', JSON.stringify(sms));
              } catch (e) {
                console.error('SMS exception:', e.message);
              }
            } else {
              console.log(`No phone for lead ${leadId} — SMS skipped`);
            }
          }
        }
      } catch (e) {
        console.error('Webhook handler error:', e.message);
      }
    });
    return;
  }

  res.writeHead(200); res.end('VMG Leads Webhook — running');
});

server.listen(PORT, () => console.log(`VMG leads webhook listening on port ${PORT}`));
