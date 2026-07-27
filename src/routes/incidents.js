const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  let sql = `SELECT i.*, w.url AS website_url
             FROM incidents i
             JOIN websites w ON w.id = i.website_id
             WHERE i.user_id = ?`;
  const params = [req.user.id];
  if (status === 'open' || status === 'resolved') {
    sql += ' AND i.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY i.started_at DESC LIMIT 200';
  res.json({ incidents: db.prepare(sql).all(...params) });
});

module.exports = router;
