const db = require('../db');
const { sendDownAlert, isMailConfigured } = require('./mailer');

let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:support@webguard.local',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } else {
    webpush = null;
  }
} catch {
  webpush = null;
}

function isInMaintenance(userId, websiteId, at = new Date()) {
  const iso = at.toISOString();
  const row = db
    .prepare(
      `SELECT id FROM maintenance_windows
       WHERE user_id = ?
         AND starts_at <= ?
         AND ends_at >= ?
         AND (website_id IS NULL OR website_id = ?)
       LIMIT 1`
    )
    .get(userId, iso, iso, websiteId);
  return Boolean(row);
}

function getIntegrations(userId) {
  return (
    db.prepare('SELECT * FROM integrations WHERE user_id = ?').get(userId) || {
      user_id: userId,
      slack_webhook_url: null,
      discord_webhook_url: null,
      custom_webhook_url: null,
      slack_enabled: 0,
      discord_enabled: 0,
      webhook_enabled: 0,
    }
  );
}

async function postWebhook(url, payload) {
  if (!url) return;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webhook ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function sendWebPush(userId, title, message) {
  if (!webpush) return;
  const subs = db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .all(userId);
  const payload = JSON.stringify({ title, body: message });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload
      );
    } catch (err) {
      console.warn('[notify] push failed:', err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }
}

/**
 * Fan-out alert: email + slack/discord/custom webhook + web push.
 * Honors alerts_enabled and maintenance windows when websiteId provided.
 */
async function notifyAlert({
  userId,
  websiteId = null,
  url = '',
  title,
  message,
  severity = 'critical',
  ownerName = null,
  statusCode = null,
  skipMaintenanceCheck = false,
}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return { skipped: true, reason: 'no_user' };

  const alertsOn =
    user.alerts_enabled === undefined || user.alerts_enabled === null
      ? true
      : Boolean(user.alerts_enabled);
  if (!alertsOn) return { skipped: true, reason: 'alerts_disabled' };

  if (!skipMaintenanceCheck && websiteId && isInMaintenance(userId, websiteId)) {
    console.log('[notify] muted by maintenance window for website', websiteId);
    return { skipped: true, reason: 'maintenance' };
  }

  const website = websiteId
    ? db.prepare('SELECT owner_email FROM websites WHERE id = ?').get(websiteId)
    : null;
  const to =
    (website?.owner_email || user.alert_email || user.email || '').trim().toLowerCase();

  const results = { email: null, slack: null, discord: null, webhook: null, push: null };

  if (isMailConfigured() && to) {
    try {
      results.email = await sendDownAlert({
        to,
        ownerName: ownerName || user.name,
        url: url || 'https://webguard.app',
        statusCode,
        message: `${title}\n\n${message}`,
      });
    } catch (err) {
      results.email = { error: err.message };
      console.error('[notify] email failed:', err.message);
    }
  }

  const integ = getIntegrations(userId);
  const payload = {
    text: `*${title}*\n${message}${url ? `\n${url}` : ''}`,
    content: `**${title}**\n${message}${url ? `\n${url}` : ''}`,
    title,
    message,
    severity,
    url,
  };

  if (integ.slack_enabled && integ.slack_webhook_url) {
    try {
      await postWebhook(integ.slack_webhook_url, { text: payload.text });
      results.slack = { ok: true };
    } catch (err) {
      results.slack = { error: err.message };
    }
  }
  if (integ.discord_enabled && integ.discord_webhook_url) {
    try {
      await postWebhook(integ.discord_webhook_url, { content: payload.content });
      results.discord = { ok: true };
    } catch (err) {
      results.discord = { error: err.message };
    }
  }
  if (integ.webhook_enabled && integ.custom_webhook_url) {
    try {
      await postWebhook(integ.custom_webhook_url, payload);
      results.webhook = { ok: true };
    } catch (err) {
      results.webhook = { error: err.message };
    }
  }

  try {
    await sendWebPush(userId, title, message);
    results.push = { ok: true };
  } catch (err) {
    results.push = { error: err.message };
  }

  return results;
}

function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

module.exports = {
  notifyAlert,
  isInMaintenance,
  getIntegrations,
  vapidPublicKey,
  postWebhook,
};
