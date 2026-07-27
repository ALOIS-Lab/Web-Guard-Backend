const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.*, w.url AS website_url
       FROM maintenance_windows m
       LEFT JOIN websites w ON w.id = m.website_id
       WHERE m.user_id = ?
       ORDER BY m.starts_at DESC`
    )
    .all(req.user.id);
  res.json({ windows: rows });
});

router.post('/', (req, res) => {
  const starts = String(req.body?.starts_at || '').trim();
  const ends = String(req.body?.ends_at || '').trim();
  const note = req.body?.note != null ? String(req.body.note).trim() : null;
  let websiteId = req.body?.website_id != null && req.body.website_id !== ''
    ? Number(req.body.website_id)
    : null;

  if (!starts || !ends) {
    return res.status(400).json({ error: 'starts_at and ends_at are required (ISO datetime)' });
  }
  if (new Date(ends) <= new Date(starts)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  if (websiteId) {
    const w = db
      .prepare('SELECT id FROM websites WHERE id = ? AND user_id = ?')
      .get(websiteId, req.user.id);
    if (!w) return res.status(400).json({ error: 'Website not found' });
  }

  const result = db
    .prepare(
      `INSERT INTO maintenance_windows (user_id, website_id, starts_at, ends_at, note)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(req.user.id, websiteId, new Date(starts).toISOString(), new Date(ends).toISOString(), note);

  const row = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ window: row });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare('SELECT * FROM maintenance_windows WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
