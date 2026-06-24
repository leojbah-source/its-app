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
const adminReportsRoutes = require('./routes/admin.reports.routes');
const judgeRoutes = require('./routes/judge.routes');
const registerRoutes = require('./routes/register.routes');
const publicRoutes = require('./routes/public.routes');
const pwaRoutes = require('./routes/pwa.routes');
const path = require('path');

const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://talentscan.kcabah.com'
  ],
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
app.use('/api/admin/judges', adminJudgesRoutes);
app.use('/api/admin/chest', adminChestRoutes);
app.use('/api/admin/tiebreaker', adminTiebreakerRoutes);
app.use('/api/admin/awards', adminAwardsRoutes);
app.use('/api/admin/finance', adminFinanceRoutes);
app.use('/api/admin/reports', adminReportsRoutes);

// --- Judge ---
app.use('/api/judge', judgeRoutes);

// --- Public registration (no auth) ---
app.use('/api/register', registerRoutes);

// --- Public read-only data (no auth) ---
app.use('/api/public', publicRoutes);

// --- Participant PWA (pwa-login JWT) ---
app.use('/api/pwa', pwaRoutes);

// 404 handler
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
