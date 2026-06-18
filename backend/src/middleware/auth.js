// src/middleware/auth.js
const jwt = require('jsonwebtoken');

/**
 * Verifies the Bearer JWT and attaches the decoded payload to req.user.
 * Expected payload shapes (set at sign time, see routes/auth.routes.js):
 *   Admin/staff : { id, role, type: 'staff', email }
 *   Judge       : { id, judgeId, role: 'Judge', type: 'judge', phone }
 *   PWA parent  : { childId, regYearId, role: 'PWA', type: 'pwa' }
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Restricts a route to one or more roles, e.g. requireRole('Chairman', 'SuperAdmin') */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role for this action' });
    }
    next();
  };
}

/** Restricts a route to a specific token type (staff / judge / pwa) */
function requireType(...allowedTypes) {
  return (req, res, next) => {
    if (!req.user || !allowedTypes.includes(req.user.type)) {
      return res.status(403).json({ error: 'Forbidden: wrong token type for this endpoint' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, requireType };
