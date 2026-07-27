const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { runCheck, slugify } = require('../services/scanner');
const { isValidEmail } = require('../services/mailer');
const { parseMonitorConfig } = require('../services/probes');

const router = express.Router();
router.use(requireAuth);

function normalizeUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeOwnerEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || !isValidEmail(email)) return null;
  return email;
}

function parseTags(raw) {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

/**
 * HTTP / HTTPS monitors only.
 * @returns {{ ok: true, type: string, url: string, config: object } | { ok: false, error: string }}
 */
function buildMonitorFromBody(body, existing = null) {
  const type = String(body?.monitor_type || existing?.monitor_type || 'http')
    .trim()
    .toLowerCase();
  if (type && type !== 'http') {
    return { ok: false, error: 'Only HTTP/HTTPS website monitors are supported' };
  }

  const url = normalizeUrl(body?.url ?? existing?.url);
  if (!url) return { ok: false, error: 'A valid HTTP or HTTPS URL is required' };
  const expectedStatus = Number(
    body?.expected_status ?? body?.monitor_config?.expected_status ?? 200
  );
  return {
    ok: true,
    type: 'http',
    url,
    config: {
      expected_status: Number.isFinite(expectedStatus) ? expectedStatus : 200,
      timeout_sec: Number(body?.timeout_sec ?? body?.monitor_config?.timeout_sec ?? 15) || 15,
      retries: Number(body?.retries ?? body?.monitor_config?.retries ?? 0) || 0,
      notify_channel: String(body?.notify_channel || body?.monitor_config?.notify_channel || 'email'),
      region: String(body?.region || body?.monitor_config?.region || 'us-east'),
    },
  };
}

function enrichSite(row) {
  if (!row) return null;
  let tags = [];
  try {
    tags = row.tags ? JSON.parse(row.tags) : [];
  } catch {
    tags = [];
  }
  const monitor_config = parseMonitorConfig(row.monitor_config);
  const openIncident = db
    .prepare(
      `SELECT id, started_at, summary FROM incidents WHERE website_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`
    )
    .get(row.id);
  const snapshot = db
    .prepare(
      `SELECT id, body_snippet, headers_json, created_at FROM failure_snapshots WHERE website_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(row.id);
  return {
    ...row,
    monitor_type: row.monitor_type || 'http',
    monitor_config,
    tags,
    open_incident: openIncident || null,
    failure_snapshot: snapshot || null,
  };
}

router.get('/', (req, res) => {
  const tag = req.query.tag ? String(req.query.tag).toLowerCase() : null;
  const groupId = req.query.group_id ? Number(req.query.group_id) : null;
  const typeFilter = req.query.monitor_type
    ? String(req.query.monitor_type).toLowerCase()
    : 'http';

  let sites = db
    .prepare(`SELECT * FROM websites WHERE user_id = ? ORDER BY created_at DESC`)
    .all(req.user.id)
    .map(enrichSite);

  if (groupId) sites = sites.filter((s) => s.group_id === groupId);
  if (tag) {
    sites = sites.filter((s) => (s.tags || []).some((t) => String(t).toLowerCase() === tag));
  }
  // Product supports HTTP/HTTPS monitors only
  sites = sites.filter((s) => (s.monitor_type || 'http') === 'http');
  if (typeFilter && typeFilter !== 'http') {
    sites = [];
  }

  res.json({ websites: sites });
});

router.post('/', (req, res) => {
  const built = buildMonitorFromBody(req.body);
  if (!built.ok) return res.status(400).json({ error: built.error });

  const ownerEmail = normalizeOwnerEmail(req.body?.owner_email);
  const intervalMin = Number(req.body?.interval_min ?? 5);
  const keyword =
    built.type === 'http' && req.body?.keyword != null
      ? String(req.body.keyword).trim()
      : null;
  const threshold =
    req.body?.response_threshold_ms != null && req.body.response_threshold_ms !== ''
      ? Number(req.body.response_threshold_ms)
      : null;
  const tags = parseTags(req.body?.tags);
  const groupId = req.body?.group_id ? Number(req.body.group_id) : null;

  if (!ownerEmail) {
    return res.status(400).json({ error: 'A valid website owner email is required for down alerts' });
  }
  if (![0.5, 1, 2, 5, 10, 15, 30, 60].some((v) => Math.abs(v - intervalMin) < 0.001)) {
    return res.status(400).json({ error: 'interval_min must be 0.5, 1, 2, 5, 10, 15, 30, or 60' });
  }
  if (threshold != null && (!Number.isFinite(threshold) || threshold < 50)) {
    return res.status(400).json({ error: 'response_threshold_ms must be >= 50' });
  }
  if (groupId) {
    const g = db.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ?').get(groupId, req.user.id);
    if (!g) return res.status(400).json({ error: 'Group not found' });
  }

  const result = db
    .prepare(
      `INSERT INTO websites
        (user_id, url, owner_email, interval_min, status, keyword, response_threshold_ms, tags, group_id, regions, monitor_type, monitor_config)
       VALUES (?, ?, ?, ?, 'checking', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      built.url,
      ownerEmail,
      intervalMin,
      keyword || null,
      threshold,
      JSON.stringify(tags),
      groupId,
      '["us-east"]',
      built.type,
      JSON.stringify(built.config)
    );

  const id = result.lastInsertRowid;
  const slug = slugify(built.url, id);
  db.prepare('UPDATE websites SET slug = ? WHERE id = ?').run(slug, id);

  res.status(201).json({ website: enrichSite(db.prepare('SELECT * FROM websites WHERE id = ?').get(id)) });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const website = db
    .prepare('SELECT * FROM websites WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!website) return res.status(404).json({ error: 'Website not found' });

  let nextUrl = website.url;
  let nextInterval = website.interval_min;
  let nextOwner = website.owner_email;
  let nextKeyword = website.keyword;
  let nextThreshold = website.response_threshold_ms;
  let nextTags = website.tags;
  let nextGroup = website.group_id;
  let nextType = website.monitor_type || 'http';
  let nextConfig = website.monitor_config;

  const touchesMonitor =
    req.body?.monitor_type !== undefined ||
    req.body?.url !== undefined ||
    req.body?.host !== undefined ||
    req.body?.hostname !== undefined ||
    req.body?.port !== undefined ||
    req.body?.record_type !== undefined ||
    req.body?.expected !== undefined ||
    req.body?.expected_records !== undefined ||
    req.body?.monitor_config !== undefined;

  if (touchesMonitor) {
    const existingConfig = parseMonitorConfig(website.monitor_config);
    const built = buildMonitorFromBody(
      {
        ...existingConfig,
        monitor_type: req.body?.monitor_type ?? website.monitor_type,
        url: req.body?.url,
        host: req.body?.host ?? existingConfig.host,
        hostname: req.body?.hostname ?? existingConfig.hostname,
        port: req.body?.port ?? existingConfig.port,
        record_type: req.body?.record_type ?? existingConfig.record_type,
        expected: req.body?.expected ?? req.body?.expected_records ?? existingConfig.expected,
        monitor_config: {
          ...existingConfig,
          ...(typeof req.body?.monitor_config === 'object' ? req.body.monitor_config : {}),
        },
      },
      website
    );
    if (!built.ok) return res.status(400).json({ error: built.error });
    nextUrl = built.url;
    nextType = built.type;
    nextConfig = JSON.stringify(built.config);
    if (built.type !== 'http') nextKeyword = null;
  }

  if (req.body?.interval_min !== undefined) {
    const intervalMin = Number(req.body.interval_min);
    if (![0.5, 1, 2, 5, 10, 15, 30, 60].some((v) => Math.abs(v - intervalMin) < 0.001)) {
      return res.status(400).json({ error: 'interval_min must be 0.5, 1, 2, 5, 10, 15, 30, or 60' });
    }
    nextInterval = intervalMin;
  }
  if (req.body?.owner_email !== undefined) {
    const ownerEmail = normalizeOwnerEmail(req.body.owner_email);
    if (!ownerEmail) return res.status(400).json({ error: 'A valid website owner email is required' });
    nextOwner = ownerEmail;
  }
  if (req.body?.keyword !== undefined && nextType === 'http') {
    nextKeyword = String(req.body.keyword || '').trim() || null;
  }
  if (req.body?.response_threshold_ms !== undefined) {
    if (req.body.response_threshold_ms === null || req.body.response_threshold_ms === '') {
      nextThreshold = null;
    } else {
      const t = Number(req.body.response_threshold_ms);
      if (!Number.isFinite(t) || t < 50) {
        return res.status(400).json({ error: 'response_threshold_ms must be >= 50' });
      }
      nextThreshold = t;
    }
  }
  if (req.body?.tags !== undefined) {
    nextTags = JSON.stringify(parseTags(req.body.tags));
  }
  if (req.body?.group_id !== undefined) {
    if (req.body.group_id === null || req.body.group_id === '') nextGroup = null;
    else {
      const gid = Number(req.body.group_id);
      const g = db.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ?').get(gid, req.user.id);
      if (!g) return res.status(400).json({ error: 'Group not found' });
      nextGroup = gid;
    }
  }

  db.prepare(
    `UPDATE websites SET url = ?, owner_email = ?, interval_min = ?, keyword = ?,
      response_threshold_ms = ?, tags = ?, group_id = ?, monitor_type = ?, monitor_config = ?
     WHERE id = ?`
  ).run(
    nextUrl,
    nextOwner,
    nextInterval,
    nextKeyword,
    nextThreshold,
    nextTags,
    nextGroup,
    nextType,
    nextConfig,
    id
  );

  res.json({ website: enrichSite(db.prepare('SELECT * FROM websites WHERE id = ?').get(id)) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const website = db
    .prepare('SELECT * FROM websites WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!website) return res.status(404).json({ error: 'Website not found' });

  db.prepare('DELETE FROM failure_snapshots WHERE website_id = ?').run(id);
  db.prepare('DELETE FROM test_results WHERE website_id = ?').run(id);
  db.prepare('DELETE FROM website_regions WHERE website_id = ?').run(id);
  db.prepare('DELETE FROM checks WHERE website_id = ?').run(id);
  db.prepare('DELETE FROM alerts WHERE website_id = ?').run(id);
  db.prepare('DELETE FROM incidents WHERE website_id = ?').run(id);
  db.prepare('DELETE FROM websites WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.post('/:id/scan', async (req, res) => {
  const id = Number(req.params.id);
  const website = db
    .prepare('SELECT * FROM websites WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!website) return res.status(404).json({ error: 'Website not found' });

  try {
    const result = await runCheck(id, { forceEmail: true });
    res.json(result);
  } catch (err) {
    console.error('[scan]', err);
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

router.get('/:id/checks', (req, res) => {
  const id = Number(req.params.id);
  const website = db
    .prepare('SELECT * FROM websites WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!website) return res.status(404).json({ error: 'Website not found' });

  const checks = db
    .prepare(
      `SELECT id, website_id, status_code, response_ms, status, checked_at
       FROM checks WHERE website_id = ? ORDER BY checked_at DESC LIMIT 200`
    )
    .all(id);

  res.json({ checks, website: enrichSite(website) });
});

router.get('/:id/tests', (req, res) => {
  const id = Number(req.params.id);
  const website = db
    .prepare('SELECT id FROM websites WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!website) return res.status(404).json({ error: 'Website not found' });

  const rows = db
    .prepare(
      `SELECT t.id, t.website_id, t.scan_id, t.test_type, t.status, t.summary, t.details, t.created_at
       FROM test_results t
       INNER JOIN (
         SELECT test_type, MAX(id) AS max_id
         FROM test_results
         WHERE website_id = ?
         GROUP BY test_type
       ) latest ON latest.max_id = t.id
       ORDER BY t.test_type ASC`
    )
    .all(id);

  const tests = rows.map((r) => {
    let details = {};
    try {
      details = r.details ? JSON.parse(r.details) : {};
    } catch {
      details = {};
    }
    return { ...r, details };
  });

  const byType = Object.fromEntries(tests.map((t) => [t.test_type, t]));
  const ordered = ['broken_links', 'seo_basics'].map(
    (type) =>
      byType[type] || {
        test_type: type,
        status: null,
        summary: null,
        details: null,
        created_at: null,
      }
  );

  res.json({ tests: ordered });
});

module.exports = router;
