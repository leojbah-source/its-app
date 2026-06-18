// src/utils/notify.js
// Thin, pluggable notification layer. WHATSAPP_PROVIDER selects the backend
// (Green API or WhatsApp Business API) per Master Context tech stack.
const axios = require('axios');

async function sendWhatsApp(toPhone, message) {
  if (!toPhone || !process.env.WHATSAPP_API_BASE_URL) {
    console.warn('WhatsApp not configured - skipping send to', toPhone);
    return { skipped: true };
  }
  try {
    if (process.env.WHATSAPP_PROVIDER === 'green-api') {
      const url = `${process.env.WHATSAPP_API_BASE_URL}/waInstance${process.env.WHATSAPP_INSTANCE_ID}/sendMessage/${process.env.WHATSAPP_API_KEY}`;
      const { data } = await axios.post(url, { chatId: `${toPhone}@c.us`, message });
      return data;
    }
    // Generic WhatsApp Business API fallback
    const { data } = await axios.post(
      `${process.env.WHATSAPP_API_BASE_URL}/messages`,
      { to: toPhone, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}` } }
    );
    return data;
  } catch (err) {
    console.error('WhatsApp send failed:', err.message);
    return { error: err.message };
  }
}

module.exports = { sendWhatsApp };
