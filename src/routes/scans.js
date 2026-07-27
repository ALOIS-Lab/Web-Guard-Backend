const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const checks = db
    .prepare(
      `SELECT c.id, c.website_id, c.status_code, c.response_ms, c.status, c.checked_at, w.url
       FROM checks c
       INNER JOIN websites w ON w.id = c.website_id
       WHERE w.user_id = ?
       ORDER BY c.checked_at DESC
       LIMIT 500`
    )
    .all(req.user.id);

  res.json({ scans: checks });
});

module.exports = router;
