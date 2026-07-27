const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const members = db
    .prepare(
      `SELECT id, owner_user_id, email, role, status, member_user_id, created_at, invite_token
       FROM team_members WHERE owner_user_id = ? ORDER BY created_at DESC`
    )
    .all(req.user.id);
  res.json({ members });
});

router.post('/invites', requireAuth, (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const role = req.body?.role === 'admin' ? 'admin' : 'viewer';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (email === req.user.email) {
    return res.status(400).json({ error: 'You cannot invite yourself' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const result = db
    .prepare(
      `INSERT INTO team_members (owner_user_id, email, role, invite_token, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .run(req.user.id, email, role, token);
  const member = db.prepare('SELECT * FROM team_members WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({
    member,
    invite_url: `/app/team?token=${token}`,
  });
});

router.post('/accept', requireAuth, (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Invite token required' });
  const invite = db
    .prepare(`SELECT * FROM team_members WHERE invite_token = ? AND status = 'pending'`)
    .get(token);
  if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
  if (invite.email !== req.user.email) {
    return res.status(403).json({
      error: `Sign in as ${invite.email} to accept this invite`,
    });
  }
  db.prepare(
    `UPDATE team_members SET status = 'accepted', member_user_id = ?, invite_token = NULL WHERE id = ?`
  ).run(req.user.id, invite.id);
  res.json({ ok: true, owner_user_id: invite.owner_user_id, role: invite.role });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare('SELECT * FROM team_members WHERE id = ? AND owner_user_id = ?')
    .get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Member not found' });
  db.prepare('DELETE FROM team_members WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
