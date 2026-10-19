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
      // Pool + rate-limit so a bulk run (e.g. schedule emails) doesn't open a
      // burst of connections and get throttled/blocked by the provider.
      pool: true,
      maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS || 3),
      maxMessages: Number(process.env.SMTP_MAX_MESSAGES || 50),
      rateDelta: Number(process.env.SMTP_RATE_DELTA_MS || 1000),
      rateLimit: Number(process.env.SMTP_RATE_LIMIT || 6),
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

const SITE = 'https://talentscan.kcabah.com';
const PWA_BOARD = `${SITE}/pwa`;
const PWA_LOGIN = `${SITE}/pwa/login`;
const KCA_SITE = 'https://kcabah.com';
const HELP_WHATSAPP = '3898 4900';

const NAVY = '#1e3a5f';
const GOLD = '#c9a227';

const fmtBD = (v) => `BD ${Number(v || 0).toFixed(3)}`;
const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const fmtDob = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? esc(String(d).slice(0, 10))
    : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const genderLabel = (g) => (g === 'M' ? 'Male' : g === 'F' ? 'Female' : esc(g || ''));
const payStatusLabel = (s) =>
  s === 'confirmed' ? 'Confirmed'
    : s === 'pending' ? 'Pending — subject to KCA confirmation of receipt'
    : titleCase(s);

/** Single registration-confirmation email (thank-you + all entered details). */
function registrationConfirmationHtml({ yearLabel, rulesUrl, logoUrl, parent, participant, items, payments, summary }) {
  const rulesHref = rulesUrl ? (/^https?:\/\//.test(rulesUrl) ? rulesUrl : `${SITE}${rulesUrl}`) : null;
  const logoHref = logoUrl ? (/^https?:\/\//.test(logoUrl) ? logoUrl : `${SITE}${logoUrl}`) : null;

  const row = (label, value) => value
    ? `<tr><td style="padding:5px 10px;color:#64748b;white-space:nowrap;vertical-align:top">${esc(label)}</td>
           <td style="padding:5px 10px;font-weight:600">${value}</td></tr>` : '';

  const parentRows = [
    row('Name', esc(parent.full_name)),
    row('Email', esc(parent.email)),
    row('Contact number', esc(parent.phone)),
    row('WhatsApp', esc(parent.whatsapp_number)),
    row('KCA member ID', esc(parent.kca_member_no)),
  ].join('');

  const childRows = [
    row('Name', esc(participant.full_name)),
    row('CPR number', esc(participant.cpr_number)),
    row('Date of birth', fmtDob(participant.dob)),
    row('Gender', genderLabel(participant.gender)),
    row('Age group', esc(participant.age_group_label)),
    row('School', esc(participant.school_name)),
    row('Guardian', esc(participant.guardian_name)),
    row('Guardian contact', esc(participant.guardian_phone)),
  ].join('');

  const eventRows = items.map((r) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.event_code)}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.event_name)}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtBD(r.fee_amount)}</td></tr>`).join('');

  const payRows = payments.map((p) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${titleCase(String(p.method).replace('_', ' '))}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee">${payStatusLabel(p.status)}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtBD(p.amount)}</td></tr>`).join('');

  const paidSubmitted = payments
    .filter((p) => p.status === 'pending' || p.status === 'confirmed')
    .reduce((t, p) => t + Number(p.amount || 0), 0);
  const balance = Math.max(Number(summary.fees_total || 0) - paidSubmitted, 0);

  const sectionTitle = (t) =>
    `<h3 style="color:${NAVY};font-size:15px;margin:22px 0 8px">${t}</h3>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;color:#1e293b;font-size:14px;line-height:1.5">
    ${logoHref ? `
    <div style="border-top:5px solid ${GOLD};background:#ffffff;text-align:center;padding:16px;border:1px solid #e2e8f0;border-bottom:none;border-radius:8px 8px 0 0">
      <img src="${logoHref}" alt="Indian Talent Scan" width="150" style="width:150px;max-width:60%;height:auto;display:inline-block" />
    </div>
    <div style="background:${NAVY};color:#fff;padding:16px 20px">
      <div style="font-size:18px;font-weight:700">${esc(yearLabel || 'KCA Indian Talent Scan')}</div>
      <div style="font-size:13px;opacity:.85;margin-top:2px">Registration confirmed</div>
    </div>` : `
    <div style="border-top:5px solid ${GOLD};background:${NAVY};color:#fff;padding:18px 20px;border-radius:8px 8px 0 0">
      <div style="font-size:18px;font-weight:700">${esc(yearLabel || 'KCA Indian Talent Scan')}</div>
      <div style="font-size:13px;opacity:.85;margin-top:2px">Registration confirmed</div>
    </div>`}

    <div style="border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px">
      <p style="margin:0 0 12px">
        Dear ${esc(parent.full_name || 'Parent / Guardian')},
      </p>
      <p style="margin:0 0 12px">
        Thank you for registering <strong>${esc(participant.full_name)}</strong> for the
        Indian Talent Scan. We wish ${esc((participant.full_name || '').split(' ')[0] || 'your child')}
        the very best of luck and a wonderful experience on stage. Your registration has been
        received and saved — the details you entered are below for your records.
      </p>

      ${sectionTitle('Parent / Guardian details')}
      <table style="border-collapse:collapse;width:100%">${parentRows}</table>

      ${sectionTitle('Participant details')}
      <table style="border-collapse:collapse;width:100%">${childRows}</table>

      ${sectionTitle('Events registered')}
      <table style="border-collapse:collapse;width:100%">
        <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Code</th>
            <th align="left" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Event</th>
            <th align="right" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Fee</th></tr>
        ${eventRows}
        <tr><td></td><td style="padding:8px 10px;font-weight:bold">Total</td>
            <td style="padding:8px 10px;text-align:right;font-weight:bold">${fmtBD(summary.fees_total)}</td></tr>
      </table>

      ${sectionTitle('Payment')}
      <table style="border-collapse:collapse;width:100%">
        <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Method</th>
            <th align="left" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Status</th>
            <th align="right" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Amount</th></tr>
        ${payRows || '<tr><td colspan="3" style="padding:6px 10px">No payment recorded yet</td></tr>'}
      </table>
      <p style="margin:8px 0 0"><strong>Balance due: ${fmtBD(balance)}</strong></p>
      <p style="font-size:12px;color:#64748b;margin:4px 0 0">
        All payments are <strong>subject to KCA's confirmation of receipt</strong>. A payment shown as
        "pending" will be marked confirmed once KCA verifies it.
      </p>

      ${sectionTitle('Stay updated')}
      <p style="margin:0 0 8px">
        Follow the schedule, notices and results on the Talent Scan app — please
        <strong>look out for all further notices and announcements there</strong>:
      </p>
      <p style="margin:0 0 10px">
        &#8226; <a href="${PWA_LOGIN}" style="color:${NAVY};font-weight:600">Your results &amp; schedule</a>
        (sign in with your child's CPR number)<br/>
        &#8226; <a href="${PWA_BOARD}" style="color:${NAVY};font-weight:600">Public results &amp; schedule board</a>
      </p>
      <p style="margin:0 0 8px">
        For any further information, visit
        <a href="${KCA_SITE}" style="color:${NAVY};font-weight:600">kcabah.com</a>
        or message us on WhatsApp at <strong>${HELP_WHATSAPP}</strong>.
      </p>

      <p style="margin:14px 0 0;padding:10px 12px;background:#fff8e1;border:1px solid #f2e2a8;border-radius:6px;font-size:13px">
        &#9888;&#65039; Please make sure to read the
        ${rulesHref
          ? `<a href="${rulesHref}" style="color:${NAVY};font-weight:700">General Rules &amp; Regulations</a>`
          : '<strong>General Rules &amp; Regulations</strong>'}
        in full — they cover eligibility, timings, grading and conduct for every event.
      </p>

      <p style="font-size:12px;color:#94a3b8;margin:18px 0 0">
        You can update your selection from the parent dashboard until the registration deadline.
        This is an automated message — please do not reply to this email.
      </p>
    </div>
  </div>`;
}

/** Per-participant "published schedule of your events" email: their events +
 *  reporting times, the PWA links, and the WhatsApp group invite. */
function scheduleEmailHtml({ yearLabel, logoUrl, parentName, participantName, ageGroup, events = [], waGroupLink, pwaUsername, note }) {
  const logoHref = logoUrl ? (/^https?:\/\//.test(logoUrl) ? logoUrl : `${SITE}${logoUrl}`) : null;
  const fmtDate = (d) => {
    if (!d) return '';
    const x = new Date(d);
    return isNaN(x) ? esc(String(d)) : x.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
  };
  // Parents sometimes paste the whole WhatsApp share text; pull out the real URL.
  const waMatch = String(waGroupLink || '').match(/https?:\/\/\S+/i);
  const waUrl = waMatch ? waMatch[0] : null;
  const noteHtml = (note && String(note).trim())
    ? esc(String(note).trim()).replace(/\n/g, '<br/>') : '';
  const anyScheduled = events.some((e) => e.scheduled);

  const eventRows = events.map((e) => {
    const when = e.scheduled
      ? `${esc(fmtDate(e.event_date))}${e.report ? ` &middot; report by <b>${esc(e.report)}</b>` : ''}`
      : '<span style="color:#b45309">To be announced</span>';
    const venue = e.scheduled && e.venue ? esc(e.venue) : '&mdash;';
    return `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #eee">${esc(e.event_name)}${e.is_team_event ? ' <span style="font-size:11px;color:#64748b">(team)</span>' : ''}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #eee">${when}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #eee">${venue}</td>
    </tr>`;
  }).join('');

  const sectionTitle = (t) => `<h3 style="color:${NAVY};font-size:15px;margin:22px 0 8px">${t}</h3>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;color:#1e293b;font-size:14px;line-height:1.5">
    ${logoHref ? `
    <div style="border-top:5px solid ${GOLD};background:#ffffff;text-align:center;padding:16px;border:1px solid #e2e8f0;border-bottom:none;border-radius:8px 8px 0 0">
      <img src="${logoHref}" alt="Indian Talent Scan" width="150" style="width:150px;max-width:60%;height:auto;display:inline-block" />
    </div>
    <div style="background:${NAVY};color:#fff;padding:16px 20px">
      <div style="font-size:18px;font-weight:700">${esc(yearLabel || 'KCA Indian Talent Scan')}</div>
      <div style="font-size:13px;opacity:.85;margin-top:2px">Your event schedule</div>
    </div>` : `
    <div style="border-top:5px solid ${GOLD};background:${NAVY};color:#fff;padding:18px 20px;border-radius:8px 8px 0 0">
      <div style="font-size:18px;font-weight:700">${esc(yearLabel || 'KCA Indian Talent Scan')}</div>
      <div style="font-size:13px;opacity:.85;margin-top:2px">Your event schedule</div>
    </div>`}

    <div style="border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px">
      <p style="margin:0 0 12px">Dear ${esc(parentName || 'Parent / Guardian')},</p>
      <p style="margin:0 0 12px">
        Here is the current schedule for <strong>${esc(participantName)}</strong>${ageGroup ? ` (Group ${esc(ageGroup)})` : ''}
        at the Indian Talent Scan.
      </p>
      ${noteHtml ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff8e1;border:1px solid #f2e2a8;border-radius:6px">${noteHtml}</p>` : ''}

      ${sectionTitle('Your events')}
      <table style="border-collapse:collapse;width:100%">
        <tr>
          <th align="left" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Event</th>
          <th align="left" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Date &amp; reporting</th>
          <th align="left" style="padding:6px 10px;border-bottom:2px solid ${NAVY}">Venue</th>
        </tr>
        ${eventRows || '<tr><td colspan="3" style="padding:8px 10px;color:#64748b">No active events found.</td></tr>'}
      </table>

      ${sectionTitle('Follow your schedule, notices &amp; results')}
      <p style="margin:0 0 10px">
        &#8226; <a href="${PWA_LOGIN}" style="color:${NAVY};font-weight:600">Your schedule &amp; results</a>
        &mdash; sign in${pwaUsername ? ` as <b>${esc(pwaUsername)}</b>` : ''} with your child's details (first 4 letters of the name + last 4 digits of the CPR).<br/>
        &#8226; <a href="${PWA_BOARD}" style="color:${NAVY};font-weight:600">Public schedule &amp; results board</a>
      </p>

      ${waUrl ? `
      ${sectionTitle('Join the WhatsApp group')}
      <p style="margin:0 0 10px">For reminders and last-minute updates, please join the official WhatsApp group:</p>
      <p style="margin:0 0 6px">
        <a href="${esc(waUrl)}" style="display:inline-block;background:#25D366;color:#fff;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:6px">Join the WhatsApp group</a>
      </p>
      <p style="margin:0;font-size:12px;color:#64748b;word-break:break-all">Or open: <a href="${esc(waUrl)}" style="color:${NAVY}">${esc(waUrl)}</a></p>
      ` : ''}

      <p style="margin:16px 0 0">
        For any help, message us on WhatsApp at <strong>${HELP_WHATSAPP}</strong> or visit
        <a href="${KCA_SITE}" style="color:${NAVY};font-weight:600">kcabah.com</a>.
      </p>
      <p style="font-size:12px;color:#94a3b8;margin:16px 0 0">
        This is an automated message &mdash; please do not reply to this email.
      </p>
    </div>
  </div>`;
}

module.exports = { sendEmail, registrationConfirmationHtml, scheduleEmailHtml };
