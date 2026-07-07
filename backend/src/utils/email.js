// src/utils/email.js
// Thin email layer (nodemailer). Skips gracefully when SMTP is not configured,
// same pattern as utils/notify.js for WhatsApp.
//
// .env: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD,
//       SMTP_FROM ("KCA ITS <no-reply@kcabah.com>"), SMTP_SECURE ("true" for 465)
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });
  }
  return transporter;
}

/** Sends an email. Returns { sent: boolean, error?: string }. Never throws. */
async function sendEmail({ to, subject, html }) {
  const t = getTransporter();
  if (!t || !to) {
    console.warn('Email not configured or no recipient - skipping send to', to);
    return { sent: false, error: 'EMAIL_NOT_CONFIGURED' };
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, html,
    });
    return { sent: true };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Registration summary email body (participant + events + fees + payments). */
function registrationSummaryHtml({ yearLabel, participant, items, payments, summary }) {
  const fmt = (v) => `BD ${Number(v || 0).toFixed(3)}`;
  const eventRows = items.map((r) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.event_code)}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.event_name)}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(r.fee_amount)}</td></tr>`).join('');
  const payRows = payments.map((p) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(p.method)}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(p.status)}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(p.amount)}</td></tr>`).join('');
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1e293b">
    <h2 style="color:#1e3a5f">${esc(yearLabel || 'KCA Indian Talent Scan')}</h2>
    <p>Registration summary for <strong>${esc(participant.full_name)}</strong>
       (CPR ${esc(participant.cpr_number)}${participant.age_group_label ? ', ' + esc(participant.age_group_label) : ''}).
       Please review the details below — you can update the selection from your
       parent dashboard until the registration deadline.</p>
    <h3 style="color:#1e3a5f">Events selected</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid #1e3a5f">Code</th>
          <th align="left" style="padding:6px 10px;border-bottom:2px solid #1e3a5f">Event</th>
          <th align="right" style="padding:6px 10px;border-bottom:2px solid #1e3a5f">Fee</th></tr>
      ${eventRows}
      <tr><td></td><td style="padding:8px 10px;font-weight:bold">Total</td>
          <td style="padding:8px 10px;text-align:right;font-weight:bold">${fmt(summary.fees_total)}</td></tr>
    </table>
    <h3 style="color:#1e3a5f">Payments</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid #1e3a5f">Method</th>
          <th align="left" style="padding:6px 10px;border-bottom:2px solid #1e3a5f">Status</th>
          <th align="right" style="padding:6px 10px;border-bottom:2px solid #1e3a5f">Amount</th></tr>
      ${payRows || '<tr><td colspan="3" style="padding:6px 10px">No payments yet</td></tr>'}
    </table>
    <p style="font-size:14px"><strong>Balance due: BD ${Number(Math.max(summary.balance_due, 0)).toFixed(3)}</strong></p>
    <p style="font-size:12px;color:#64748b">Payments marked pending will be confirmed by KCA.
       This is an automated message — please contact the KCA office for queries.</p>
  </div>`;
}

module.exports = { sendEmail, registrationSummaryHtml };
