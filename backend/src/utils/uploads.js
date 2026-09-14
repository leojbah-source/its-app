// Central upload directory.
// In production on Render, UPLOAD_DIR points at a persistent disk mount
// (e.g. /var/data/uploads) so uploaded files survive redeploys. Locally, and
// anywhere UPLOAD_DIR is unset, it falls back to the repo's public/uploads.
// Files here are served publicly at /uploads/<filename> (see index.js).
const path = require('path');
const fs = require('fs');

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

module.exports = { uploadDir };
