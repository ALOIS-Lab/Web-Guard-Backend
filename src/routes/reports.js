const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/uptime', (req, res) => {
  const range = String(req.query.range || '24h');
  let hours = 24;
  if (range === '7d') hours = 24 * 7;
  else if (range === '30d') hours = 24 * 30;

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const sites = db
    .prepare('SELECT id, url FROM websites WHERE user_id = ?')
    .all(req.user.id);

  const series = [];
  for (const site of sites) {
    const checks = db
      .prepare(
        `SELECT status, response_ms, checked_at FROM checks
         WHERE website_id = ? AND checked_at >= ?
         ORDER BY checked_at ASC`
      )
      .all(site.id, since);
    const healthy = checks.filter((c) => c.status === 'healthy' || c.status === 'slow').length;
    const withMs = checks.filter((c) => c.response_ms != null);
    const avgMs = withMs.length
      ? Math.round(withMs.reduce((a, c) => a + c.response_ms, 0) / withMs.length)
      : null;
    series.push({
      website_id: site.id,
      url: site.url,
      points: checks.map((c) => ({
        t: c.checked_at,
        status: c.status,
        ms: c.response_ms,
        up: c.status === 'healthy' || c.status === 'slow' ? 1 : 0,
      })),
      uptime: checks.length ? Math.round((healthy / checks.length) * 1000) / 10 : null,
      avg_ms: avgMs,
      total: checks.length,
    });
  }

  res.json({ range, since, series });
});

module.exports = router;
