// src/index.js -- KCA Indian Talent Scan (ITS) backend entry point
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const adminConfigRoutes = require('./routes/admin.config.routes');
const adminEventsRoutes = require('./routes/admin.events.routes');
const adminJudgingRoutes = require('./routes/admin.judging.routes');
const adminResultsRoutes = require('./routes/admin.results.routes');
const adminRegistrationsRoutes = require('./routes/admin.registrations.routes');
const adminJudgesRoutes = require('./routes/admin.judges.routes');
const adminChestRoutes = require('./routes/admin.chest.routes');
const adminTiebreakerRoutes = require('./routes/admin.tiebreaker.routes');
const adminAwardsRoutes = require('./routes/admin.awards.routes');
const adminFinanceRoutes = require('./routes/admin.finance.routes');
const adminPaymentsRoutes = require('./routes/admin.payments.routes');
const adminListsRoutes = require('./routes/admin.lists.routes');
const adminScheduleRoutes = require('./routes/admin.schedule.routes');
const adminReportsRoutes = require('./routes/admin.reports.routes');
const judgeRoutes = require('./routes/judge.routes');
const adminEventStaffRoutes = require('./routes/admin.eventstaff.routes');
const mcRoutes = require('./routes/mc.routes');
const timerRoutes = require('./routes/timer.routes');
const registerRoutes = require('./routes/register.routes');
const publicRoutes = require('./routes/public.routes');
const pwaRoutes = require('./routes/pwa.routes');
const path = require('path');

const app = express();

// Allowed browser origins. Extra origins (a deployed/tunnel frontend URL) can be
// added via env without editing code: CORS_ORIGINS="https://a.com,https://b.com"
// (FRONTEND_URL is also honoured). When the backend serves the built frontend
// itself (single-origin, see bottom of file) CORS isn't needed at all.
const envOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: ['http://localhost:5173', 'https://talentscan.kcabah.com', ...envOrigins],
  credentials: true
}));

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'kca-its-backend' }));

// --- Auth ---
app.use('/api/auth', authRoutes);

// --- Admin: year config, events, judging, results all share the /api/admin
// prefix; each router already namespaces its own sub-paths (/config, /events,
// /scoring, /results, /schedule, /criteria-confirm -- see route map). ---
app.use('/api/admin', adminConfigRoutes);
app.use('/api/admin', adminEventsRoutes);
app.use('/api/admin', adminJudgingRoutes);
app.use('/api/admin', adminResultsRoutes);

// --- Admin: feature areas with their own dedicated prefix ---
app.use('/api/admin', adminRegistrationsRoutes);
app.use('/api/admin', adminPaymentsRoutes);
app.use('/api/admin/judges', adminJudgesRoutes);
app.use('/api/admin/chest', adminChestRoutes);
app.use('/api/admin/tiebreaker', adminTiebreakerRoutes);
app.use('/api/admin/awards', adminAwardsRoutes);
app.use('/api/admin/finance', adminFinanceRoutes);
app.use('/api/admin/lists', adminListsRoutes);
app.use('/api/admin/schedule', adminScheduleRoutes);
app.use('/api/admin/reports', adminReportsRoutes);

// --- Judge ---
app.use('/api/judge', judgeRoutes);
app.use('/api/admin/event-staff', adminEventStaffRoutes);
app.use('/api/mc', mcRoutes);
app.use('/api/timer', timerRoutes);

// --- Public registration (no auth) ---
app.use('/api/register', registerRoutes);

// --- Public read-only data (no auth) ---
app.use('/api/public', publicRoutes);

// --- Participant PWA (pwa-login JWT) ---
app.use('/api/pwa', pwaRoutes);

// --- Serve the built frontend (single-origin) so the whole app is one URL. ---
// Enabled only when frontend/dist exists (i.e. after `npm run build`). In local
// dev the frontend runs on Vite (5173) and this block is skipped, so /api 404s
// still return JSON.
const fs = require('fs');
const distDir = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback as plain middleware (Express 5 no longer allows an app.get('*')
  // wildcard route). Any GET that isn't an API/uploads/health path returns the app.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path === '/health') return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// 404 handler (API paths, and everything when no build is present)
app.use((req, res) => {
  res.status(404).json({ error: `No route found for ${req.method} ${req.originalUrl}` });
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`KCA ITS backend listening on port ${PORT}`);
});

module.exports = app;
