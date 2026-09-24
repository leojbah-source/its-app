// src/utils/notify.js
// Pluggable WhatsApp layer. WHATSAPP_PROVIDER selects the backend (Green API or
// WhatsApp Business API). When no provider is configured (e.g. local testing),
// sends are skipped but a click-to-chat wa.me LINK is returned so the message
// can still be delivered via WhatsApp manually.
const axios = require('axios');

// WhatsApp needs full international digits. Normalise what parents enter:
//  - strip spaces, +, dashes;  - drop a leading 00 (intl prefix);
//  - a bare Bahrain 8-digit local number gets the 973 country code.
// Numbers that already include a country code (length > 8) pass through.
function intlDigits(toPhone) {
  let d = String(toPhone || '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 8) d = '973' + d;   // Bahrain local -> +973
  return d;
}

// https://wa.me/<international-digits>?text=<url-encoded message>
function waLink(toPhone, message) {
  const digits = intlDigits(toPhone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

// Normalise a group id to "<id>@g.us". Accepts "12036...@g.us" or bare digits.
function groupChatId(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  return /@g\.us$/i.test(s) ? s : `${s.replace(/[^\d-]/g, '')}@g.us`;
}

// Send to ANY WhatsApp chat id directly: an individual "<digits>@c.us" or a
// group "<id>@g.us". This is the low-level send both helpers below build on.
async function sendWhatsAppChat(chatId, message) {
  if (!chatId || !process.env.WHATSAPP_API_BASE_URL) {
    console.warn('WhatsApp not configured — skipping send to', chatId);
    return { skipped: true, delivered: false };
  }
  try {
    if (process.env.WHATSAPP_PROVIDER === 'green-api') {
      const url = `${process.env.WHATSAPP_API_BASE_URL}/waInstance${process.env.WHATSAPP_INSTANCE_ID}/sendMessage/${process.env.WHATSAPP_API_KEY}`;
      const { data } = await axios.post(url, { chatId, message });
      return { ...data, delivered: true };
    }
    // Generic WhatsApp Business API fallback (individual numbers only).
    const to = String(chatId).replace(/@c\.us$/i, '').replace(/@g\.us$/i, '');
    const { data } = await axios.post(
      `${process.env.WHATSAPP_API_BASE_URL}/messages`,
      { to, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}` } }
    );
    return { ...data, delivered: true };
  } catch (err) {
    console.error('WhatsApp send failed:', err.message);
    return { error: err.message, delivered: false };
  }
}

// Send to an individual phone number (normalised to international digits).
async function sendWhatsApp(toPhone, message) {
  const link = waLink(toPhone, message);
  if (!toPhone || !process.env.WHATSAPP_API_BASE_URL) {
    console.warn('WhatsApp not configured — returning click-to-chat link for', toPhone);
    return { skipped: true, delivered: false, link };
  }
  const r = await sendWhatsAppChat(`${intlDigits(toPhone)}@c.us`, message);
  return { ...r, link };
}

module.exports = { sendWhatsApp, sendWhatsAppChat, waLink, groupChatId };
