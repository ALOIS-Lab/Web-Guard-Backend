const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isValidEmail } = require('../services/mailer');
const { parseRegionIds, serializeRegionIds, ALL_REGION_IDS } = require('../regions');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function publicUser(row) {
  const accountEmail = row.email;
  const alertEmail = (row.alert_email || row.email || '').trim().toLowerCase() || accountEmail;
  return {
    id: row.id,
    name: row.name,
    email: accountEmail,
    alert_email: alertEmail,
    alerts_enabled:
      row.alerts_enabled === undefined || row.alerts_enabled === null
        ? true
        : Boolean(row.alerts_enabled),
    enabled_regions: parseRegionIds(row.enabled_regions, ALL_REGION_IDS),
  };
}

function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return 'Password must include uppercase and lowercase letters';
  }
  if (!/\d/.test(password)) {
    return 'Password must include a number';
  }
  return null;
}

router.post('/signup', (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  const pwdErr = validatePassword(password);
  if (pwdErr) {
    return res.status(400).json({ error: pwdErr });
  }

  const accountEmail = email.toLowerCase().trim();
  if (!isValidEmail(accountEmail)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(accountEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const result = db
    .prepare(
      `INSERT INTO users (name, email, password, alert_email, alerts_enabled, enabled_regions)
       VALUES (?, ?, ?, ?, 1, ?)`
    )
    .run(name.trim(), accountEmail, hashed, accountEmail, serializeRegionIds(ALL_REGION_IDS));

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  const user = publicUser(row);
  const token = signToken(user);
  res.status(201).json({ token, user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!row || !bcrypt.compareSync(password, row.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user = publicUser(row);
  const token = signToken(user);
  res.json({ token, user });
});

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user: publicUser(row) });
});

router.patch('/me', requireAuth, (req, res) => {
  const { name, email, password, alerts_enabled, alert_email, enabled_regions } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row) {
    return res.status(404).json({ error: 'User not found' });
  }

  const nextName = name !== undefined ? String(name).trim() : row.name;
  const nextEmail = email !== undefined ? String(email).toLowerCase().trim() : row.email;

  if (!nextName || !nextEmail) {
    return res.status(400).json({ error: 'Name and email cannot be empty' });
  }

  if (!isValidEmail(nextEmail)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  if (nextEmail !== row.email) {
    const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(nextEmail, req.user.id);
    if (taken) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
  }

  let nextAlertEmail =
    alert_email !== undefined
      ? String(alert_email).toLowerCase().trim()
      : (row.alert_email || row.email || '').trim().toLowerCase();

  if (email !== undefined && alert_email === undefined) {
    const prevAlert = (row.alert_email || row.email || '').trim().toLowerCase();
    if (!prevAlert || prevAlert === row.email) {
      nextAlertEmail = nextEmail;
    }
  }

  if (!isValidEmail(nextAlertEmail)) {
    return res.status(400).json({ error: 'A valid recipient email is required' });
  }

  const nextAlertsEnabled =
    alerts_enabled !== undefined ? (alerts_enabled ? 1 : 0) : row.alerts_enabled !== 0 ? 1 : 0;

  let nextEnabledRegions = parseRegionIds(row.enabled_regions, ALL_REGION_IDS);
  if (enabled_regions !== undefined) {
    nextEnabledRegions = parseRegionIds(enabled_regions, []);
    if (nextEnabledRegions.length < 1 || nextEnabledRegions.length > 6) {
      return res.status(400).json({
        error: 'Enable between 1 and 6 monitoring regions',
      });
    }
  }

  let nextPassword = row.password;
  if (password) {
    const pwdErr = validatePassword(password);
    if (pwdErr) {
      return res.status(400).json({ error: pwdErr });
    }
    nextPassword = bcrypt.hashSync(password, 10);
  }

  db.prepare(
    `UPDATE users SET name = ?, email = ?, password = ?, alert_email = ?, alerts_enabled = ?, enabled_regions = ?
     WHERE id = ?`
  ).run(
    nextName,
    nextEmail,
    nextPassword,
    nextAlertEmail,
    nextAlertsEnabled,
    serializeRegionIds(nextEnabledRegions),
    req.user.id
  );

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const user = publicUser(updated);
  const token = signToken(user);
  res.json({ user, token });
});

module.exports = router;
