const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notifyAlert, getIntegrations, postWebhook } = require('../services/notify');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  let row = getIntegrations(req.user.id);
  if (!db.prepare('SELECT user_id FROM integrations WHERE user_id = ?').get(req.user.id)) {
    db.prepare('INSERT INTO integrations (user_id) VALUES (?)').run(req.user.id);
    row = getIntegrations(req.user.id);
  }
  res.json({
    integrations: {
      slack_webhook_url: row.slack_webhook_url || '',
      discord_webhook_url: row.discord_webhook_url || '',
      custom_webhook_url: row.custom_webhook_url || '',
      slack_enabled: Boolean(row.slack_enabled),
      discord_enabled: Boolean(row.discord_enabled),
      webhook_enabled: Boolean(row.webhook_enabled),
    },
  });
});

router.patch('/', (req, res) => {
  if (!db.prepare('SELECT user_id FROM integrations WHERE user_id = ?').get(req.user.id)) {
    db.prepare('INSERT INTO integrations (user_id) VALUES (?)').run(req.user.id);
  }
  const cur = getIntegrations(req.user.id);
  const next = {
    slack_webhook_url:
      req.body?.slack_webhook_url !== undefined
        ? String(req.body.slack_webhook_url || '').trim()
        : cur.slack_webhook_url,
    discord_webhook_url:
      req.body?.discord_webhook_url !== undefined
        ? String(req.body.discord_webhook_url || '').trim()
        : cur.discord_webhook_url,
    custom_webhook_url:
      req.body?.custom_webhook_url !== undefined
        ? String(req.body.custom_webhook_url || '').trim()
        : cur.custom_webhook_url,
    slack_enabled:
      req.body?.slack_enabled !== undefined ? (req.body.slack_enabled ? 1 : 0) : cur.slack_enabled,
    discord_enabled:
      req.body?.discord_enabled !== undefined
        ? req.body.discord_enabled
          ? 1
          : 0
        : cur.discord_enabled,
    webhook_enabled:
      req.body?.webhook_enabled !== undefined
        ? req.body.webhook_enabled
          ? 1
          : 0
        : cur.webhook_enabled,
  };

  db.prepare(
    `UPDATE integrations SET slack_webhook_url = ?, discord_webhook_url = ?, custom_webhook_url = ?,
      slack_enabled = ?, discord_enabled = ?, webhook_enabled = ? WHERE user_id = ?`
  ).run(
    next.slack_webhook_url,
    next.discord_webhook_url,
    next.custom_webhook_url,
    next.slack_enabled,
    next.discord_enabled,
    next.webhook_enabled,
    req.user.id
  );

  res.json({
    integrations: {
      ...next,
      slack_enabled: Boolean(next.slack_enabled),
      discord_enabled: Boolean(next.discord_enabled),
      webhook_enabled: Boolean(next.webhook_enabled),
    },
  });
});

router.post('/test', async (req, res) => {
  const channel = String(req.body?.channel || 'slack');
  const integ = getIntegrations(req.user.id);
  try {
    if (channel === 'slack') {
      if (!integ.slack_webhook_url) return res.status(400).json({ error: 'Slack webhook URL missing' });
      await postWebhook(integ.slack_webhook_url, {
        text: '*WebGuard test*\nSlack integration is working.',
      });
    } else if (channel === 'discord') {
      if (!integ.discord_webhook_url) {
        return res.status(400).json({ error: 'Discord webhook URL missing' });
      }
      await postWebhook(integ.discord_webhook_url, {
        content: '**WebGuard test**\nDiscord integration is working.',
      });
    } else if (channel === 'webhook') {
      if (!integ.custom_webhook_url) {
        return res.status(400).json({ error: 'Custom webhook URL missing' });
      }
      await postWebhook(integ.custom_webhook_url, {
        title: 'WebGuard test',
        message: 'Custom webhook integration is working.',
        severity: 'info',
      });
    } else if (channel === 'all') {
      await notifyAlert({
        userId: req.user.id,
        title: 'WebGuard test alert',
        message: 'This is a test notification from Integrations.',
        severity: 'warning',
        skipMaintenanceCheck: true,
      });
    } else {
      return res.status(400).json({ error: 'Unknown channel' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Test failed' });
  }
});

module.exports = router;
