// src/utils/notify.js
// Pluggable WhatsApp layer. WHATSAPP_PROVIDER selects the backend (Green API or
// WhatsApp Business API). When no provider is configured (e.g. local testing),
// sends are skipped but a click-to-chat wa.me LINK is returned so the message
// can still be delivered via WhatsApp manually.
const axios = require('axios');

// https://wa.me/<international-digits>?text=<url-encoded message>
function waLink(toPhone, message) {
  const digits = String(toPhone || '').replace(/[^\d]/g, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

async function sendWhatsApp(toPhone, message) {
  const link = waLink(toPhone, message);
  if (!toPhone || !process.env.WHATSAPP_API_BASE_URL) {
    console.warn('WhatsApp not configured — returning click-to-chat link for', toPhone);
    return { skipped: true, delivered: false, link };
  }
  try {
    if (process.env.WHATSAPP_PROVIDER === 'green-api') {
      const url = `${process.env.WHATSAPP_API_BASE_URL}/waInstance${process.env.WHATSAPP_INSTANCE_ID}/sendMessage/${process.env.WHATSAPP_API_KEY}`;
      const { data } = await axios.post(url, { chatId: `${String(toPhone).replace(/[^\d]/g, '')}@c.us`, message });
      return { ...data, delivered: true, link };
    }
    // Generic WhatsApp Business API fallback
    const { data } = await axios.post(
      `${process.env.WHATSAPP_API_BASE_URL}/messages`,
      { to: toPhone, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}` } }
    );
    return { ...data, delivered: true, link };
  } catch (err) {
    console.error('WhatsApp send failed:', err.message);
    return { error: err.message, delivered: false, link };
  }
}

module.exports = { sendWhatsApp, waLink };
