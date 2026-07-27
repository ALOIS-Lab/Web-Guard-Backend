const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const groups = db
    .prepare(
      `SELECT g.*,
        (SELECT COUNT(*) FROM websites w WHERE w.group_id = g.id) AS website_count
       FROM groups g WHERE g.user_id = ? ORDER BY g.created_at DESC`
    )
    .all(req.user.id);
  res.json({ groups });
});

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const result = db
    .prepare(`INSERT INTO groups (user_id, name) VALUES (?, ?)`)
    .run(req.user.id, name);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ group: { ...group, website_count: 0 } });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
  res.json({ group: db.prepare('SELECT * FROM groups WHERE id = ?').get(id) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  db.prepare('UPDATE websites SET group_id = NULL WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
