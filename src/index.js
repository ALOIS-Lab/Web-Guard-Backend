require('dotenv').config();

const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const websitesRoutes = require('./routes/websites');
const scansRoutes = require('./routes/scans');
const alertsRoutes = require('./routes/alerts');
const supportRoutes = require('./routes/support');
const groupsRoutes = require('./routes/groups');
const integrationsRoutes = require('./routes/integrations');
const teamRoutes = require('./routes/team');
const pushRoutes = require('./routes/push');
const incidentsRoutes = require('./routes/incidents');
const maintenanceRoutes = require('./routes/maintenance');
const statusRoutes = require('./routes/status');
const reportsRoutes = require('./routes/reports');
const { startScheduler } = require('./services/scheduler');
const { verifyMailer, isMailConfigured } = require('./services/mailer');
const { vapidPublicKey } = require('./services/notify');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WebGuard API</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 640px; margin: 48px auto; padding: 0 20px; line-height: 1.5; }
    h1 { margin: 0 0 8px; font-size: 1.75rem; }
    .ok { color: #16a34a; font-weight: 600; }
    code, a { word-break: break-all; }
    ul { padding-left: 1.2rem; }
    .card { border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px 18px; margin-top: 20px; }
  </style>
</head>
<body>
  <h1>WebGuard API</h1>
  <p class="ok">● Running</p>
  <p>This is the backend API. Open the app UI at <a href="http://localhost:5173">http://localhost:5173</a>.</p>
  <div class="card">
    <strong>Useful endpoints</strong>
    <ul>
      <li><a href="/api/health"><code>GET /api/health</code></a> — health check</li>
      <li><code>POST /api/auth/signup</code> · <code>POST /api/auth/login</code></li>
      <li><code>GET /api/websites</code> · <code>POST /api/websites/:id/scan</code></li>
      <li><code>GET /api/scans</code> · <code>GET /api/alerts</code></li>
      <li><code>POST /api/support/chat</code></li>
    </ul>
  </div>
</body>
</html>`);
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Web Guard API',
    mail_configured: isMailConfigured(),
    push_configured: Boolean(vapidPublicKey()),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/websites', websitesRoutes);
app.use('/api/scans', scansRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/incidents', incidentsRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/reports', reportsRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Web Guard API listening on http://localhost:${PORT}`);
  verifyMailer().catch((err) => console.error('[mailer] verify error:', err.message));
  startScheduler();
});
