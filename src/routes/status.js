const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/:slug', (req, res) => {
  const slug = String(req.params.slug || '').trim();
  const website = db.prepare('SELECT * FROM websites WHERE slug = ?').get(slug);
  if (!website) return res.status(404).json({ error: 'Status page not found' });

  const checks = db
    .prepare(
      `SELECT status, response_ms, status_code, checked_at
       FROM checks WHERE website_id = ? ORDER BY checked_at DESC LIMIT 100`
    )
    .all(website.id);

  const healthy = checks.filter((c) => c.status === 'healthy' || c.status === 'slow').length;
  const uptime = checks.length ? Math.round((healthy / checks.length) * 1000) / 10 : null;

  const incidents = db
    .prepare(
      `SELECT id, started_at, ended_at, status, summary
       FROM incidents WHERE website_id = ? ORDER BY started_at DESC LIMIT 20`
    )
    .all(website.id);

  res.json({
    website: {
      url: website.url,
      status: website.status,
      last_checked: website.last_checked,
      slug: website.slug,
      ssl_expires_at: website.ssl_expires_at,
      domain_expires_at: website.domain_expires_at,
    },
    uptime_percent: uptime,
    checks,
    incidents,
  });
});

module.exports = router;
