// src/utils/pdf.js
// Shared PDF helper. Master Context rule #2: ALL PDFs include KCA logo +
// Title Sponsor logo, both pulled from year_config (never hard-coded).
const PDFDocument = require('pdfkit');
const axios = require('axios');
const pool = require('../db');

async function getYearLogos(yearId) {
  const { rows } = await pool.query(
    `SELECT kca_logo_url, sponsor_logo_url, year_label FROM year_config WHERE year_id = $1`,
    [yearId]
  );
  return rows[0] || { kca_logo_url: null, sponsor_logo_url: null, year_label: null };
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
    return Buffer.from(res.data);
  } catch {
    return null; // Missing/unreachable logo should never break PDF generation
  }
}

/**
 * Starts a PDF document, streams it to `res` as `filename`, and renders the
 * standard header (KCA logo left, sponsor logo right, title centered).
 * Returns the PDFDocument so the caller can keep writing content, then call doc.end().
 */
async function startBrandedPdf(res, { yearId, title, filename }) {
  const { kca_logo_url, sponsor_logo_url, year_label } = await getYearLogos(yearId);
  const [kcaLogo, sponsorLogo] = await Promise.all([
    fetchImageBuffer(kca_logo_url),
    fetchImageBuffer(sponsor_logo_url),
  ]);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  const top = doc.y;
  if (kcaLogo) doc.image(kcaLogo, 40, top, { width: 70 });
  if (sponsorLogo) doc.image(sponsorLogo, doc.page.width - 110, top, { width: 70 });

  doc.fontSize(16).text('KCA Indian Talent Scan', 0, top, { align: 'center' });
  if (year_label) doc.fontSize(10).text(year_label, { align: 'center' });
  doc.moveDown(0.5).fontSize(13).text(title, { align: 'center' });
  doc.moveDown(1.5);

  return doc;
}

module.exports = { startBrandedPdf, getYearLogos, fetchImageBuffer };
