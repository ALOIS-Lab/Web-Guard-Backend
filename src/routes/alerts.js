const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendDownAlert, isMailConfigured, alertRecipients, isValidEmail } = require('../services/mailer');

const router = express.Router();
router.use(requireAuth);

function getOwner(userId) {
  const row = db
    .prepare('SELECT email, alert_email, name, alerts_enabled FROM users WHERE id = ?')
    .get(userId);
  if (!row) return null;
  const alertEmail = (row.alert_email || row.email || '').trim().toLowerCase();
  return {
    email: row.email,
    alert_email: alertEmail || row.email,
    name: row.name,
    enabled:
      row.alerts_enabled === undefined || row.alerts_enabled === null
        ? true
        : Boolean(row.alerts_enabled),
  };
}

router.get('/', (req, res) => {
  const alerts = db
    .prepare(
      `SELECT id, user_id, website_id, url, message, severity, title, created_at
       FROM alerts
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 200`
    )
    .all(req.user.id);

  res.json({ alerts });
});

router.get('/mail-status', (req, res) => {
  const owner = getOwner(req.user.id);
  const recipient = owner?.alert_email || owner?.email || null;
  const recipients = owner?.enabled && recipient ? alertRecipients(recipient) : [];
  res.json({
    configured: isMailConfigured(),
    smtp_user: process.env.SMTP_USER || null,
    user_email: owner?.email || null,
    alert_email: recipient,
    alerts_enabled: owner?.enabled ?? false,
    recipients,
  });
});

router.patch('/recipient', (req, res) => {
  const { email } = req.body || {};
  const recipient = String(email || '')
    .trim()
    .toLowerCase();

  if (!isValidEmail(recipient)) {
    return res.status(400).json({ error: 'Enter a valid recipient email address' });
  }

  db.prepare('UPDATE users SET alert_email = ? WHERE id = ?').run(recipient, req.user.id);
  const owner = getOwner(req.user.id);
  res.json({
    ok: true,
    alert_email: owner.alert_email,
    user_email: owner.email,
  });
});

router.post('/test-email', async (req, res) => {
  if (!isMailConfigured()) {
    return res.status(503).json({
      error:
        'SMTP is not fully configured. Set SMTP_PASS in backend/.env to your Gmail App Password, then restart the API.',
    });
  }

  const owner = getOwner(req.user.id);
  if (!owner?.enabled) {
    return res.status(400).json({
      error: 'Email alerts are disabled. Enable them in Settings first.',
    });
  }

  const requested = req.body?.to != null ? String(req.body.to).trim().toLowerCase() : '';
  const to = requested || owner.alert_email || owner.email;

  if (!isValidEmail(to)) {
    return res.status(400).json({ error: 'Enter a valid recipient email address' });
  }

  // Persist so down-site alerts use the same recipient
  db.prepare('UPDATE users SET alert_email = ? WHERE id = ?').run(to, req.user.id);

  try {
    const result = await sendDownAlert({
      to,
      ownerName: owner.name,
      url: 'https://example.com/test-alert',
      statusCode: 503,
      message:
        'This is a WebGuard test alert. Your down-site notifications will be sent to this address.',
    });
    res.json({ ok: true, alert_email: to, ...result });
  } catch (err) {
    console.error('[alerts] test email failed:', err);
    res.status(500).json({ error: 'Failed to send test email', detail: err.message });
  }
});

module.exports = router;
