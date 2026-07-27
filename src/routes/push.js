const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { vapidPublicKey } = require('../services/notify');

const router = express.Router();

router.get('/vapid-public-key', (_req, res) => {
  const key = vapidPublicKey();
  if (!key) {
    return res.status(503).json({
      error: 'Web Push is not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in backend/.env',
      configured: false,
    });
  }
  res.json({ publicKey: key, configured: true });
});

router.post('/subscribe', requireAuth, (req, res) => {
  const sub = req.body?.subscription || req.body;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (existing) {
    db.prepare(
      `UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE id = ?`
    ).run(req.user.id, p256dh, auth, existing.id);
  } else {
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)`
    ).run(req.user.id, endpoint, p256dh, auth);
  }
  res.json({ ok: true });
});

router.delete('/subscribe', requireAuth, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(
    req.user.id,
    endpoint
  );
  res.json({ ok: true });
});

module.exports = router;
