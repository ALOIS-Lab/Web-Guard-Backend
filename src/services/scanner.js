const db = require('../db');
const { notifyAlert, isInMaintenance } = require('./notify');
const { getSslExpiry, getDomainExpiry, daysUntil } = require('./sslDomain');
const { runPageTests } = require('./pageTests');

const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 30);

function isUp(status) {
  return status === 'healthy' || status === 'slow';
}

function slugify(url, id) {
  const base = String(url || 'site')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'site';
  return `${base}-${id}`;
}

async function probeSite(url, { keyword } = {}) {
  const started = Date.now();
  let statusCode = null;
  let responseMs = null;
  let status = 'down';
  let body = '';
  let headers = {};
  let error = null;
  let redirected = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'WebGuard/1.0 (+monitor)' },
    });
    clearTimeout(timeout);
    statusCode = response.status;
    responseMs = Date.now() - started;
    redirected = response.redirected;
    response.headers.forEach((v, k) => {
      headers[k] = v;
    });
    body = await response.text().catch(() => '');
    status = statusCode >= 200 && statusCode < 400 ? 'healthy' : 'down';

    if (keyword && status === 'healthy') {
      if (!body.toLowerCase().includes(String(keyword).toLowerCase())) {
        status = 'down';
        error = `Expected keyword not found: "${keyword}"`;
      }
    }
  } catch (err) {
    responseMs = Date.now() - started;
    status = 'down';
    statusCode = null;
    error = err?.name === 'AbortError' ? 'Timeout' : err.message;
  }

  return { statusCode, responseMs, status, body, headers, error, redirected };
}

async function probeMonitor(website) {
  // HTTP / HTTPS only
  return probeSite(website.url, { keyword: website.keyword });
}

function alertCopyFor(website, { status, responseMs, statusCode, threshold, probe }) {
  const target = website.url;

  if (status === 'slow') {
    return {
      severity: 'warning',
      title: 'Slow Response Detected',
      message: `${target} responded in ${responseMs} ms (threshold ${threshold} ms).`,
    };
  }

  if (probe.error?.includes('keyword')) {
    return {
      severity: 'critical',
      title: 'Keyword Check Failed',
      message: probe.error,
    };
  }

  return {
    severity: 'critical',
    title: 'Website Down',
    message: `Your monitored site ${target} appears to be down${
      statusCode != null ? ` (HTTP ${statusCode})` : probe.error ? ` (${probe.error})` : ''
    }.`,
  };
}

function shouldSendAlert(websiteId, previousStatus, nextStatus) {
  if (previousStatus !== 'down' && previousStatus !== 'partial' && !isUp(previousStatus)) {
    if (!isUp(nextStatus) || nextStatus === 'slow') return true;
  }
  if (isUp(previousStatus) && (!isUp(nextStatus) || nextStatus === 'slow')) return true;
  if (previousStatus === 'slow' && nextStatus === 'down') return true;

  const lastAlert = db
    .prepare(
      `SELECT created_at FROM alerts WHERE website_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(websiteId);
  if (!lastAlert?.created_at) return true;
  const then = new Date(lastAlert.created_at).getTime();
  if (Number.isNaN(then)) return true;
  return (Date.now() - then) / 60000 >= ALERT_COOLDOWN_MIN;
}

function openOrResolveIncident(website, overall, checkedAt) {
  const open = db
    .prepare(
      `SELECT id FROM incidents WHERE website_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`
    )
    .get(website.id);

  if (!isUp(overall)) {
    if (!open) {
      db.prepare(
        `INSERT INTO incidents (user_id, website_id, started_at, status, summary)
         VALUES (?, ?, ?, 'open', ?)`
      ).run(
        website.user_id,
        website.id,
        checkedAt,
        `Outage detected for ${website.url}`
      );
    }
  } else if (open) {
    db.prepare(
      `UPDATE incidents SET status = 'resolved', ended_at = ?, summary = COALESCE(summary, '') || ' — recovered'
       WHERE id = ?`
    ).run(checkedAt, open.id);
  }
}

async function maybeCheckSslAndDomain(website) {
  const now = Date.now();
  const staleMs = 24 * 60 * 60 * 1000;
  const sslStale =
    !website.last_ssl_check || now - new Date(website.last_ssl_check).getTime() > staleMs;
  const domainStale =
    !website.last_domain_check ||
    now - new Date(website.last_domain_check).getTime() > staleMs;

  let sslExpires = website.ssl_expires_at;
  let domainExpires = website.domain_expires_at;

  if (sslStale) {
    sslExpires = (await getSslExpiry(website.url)) || sslExpires;
    db.prepare(
      `UPDATE websites SET ssl_expires_at = ?, last_ssl_check = ? WHERE id = ?`
    ).run(sslExpires, new Date().toISOString(), website.id);
  }
  if (domainStale) {
    domainExpires = (await getDomainExpiry(website.url)) || domainExpires;
    db.prepare(
      `UPDATE websites SET domain_expires_at = ?, last_domain_check = ? WHERE id = ?`
    ).run(domainExpires, new Date().toISOString(), website.id);
  }

  for (const [kind, expires] of [
    ['SSL', sslExpires],
    ['Domain', domainExpires],
  ]) {
    const days = daysUntil(expires);
    if (days == null) continue;
    if (![30, 14, 7].includes(days) && !(days < 7 && days >= 0)) continue;
    // Alert once per day threshold bucket
    const title = `${kind} Expiring`;
    const recent = db
      .prepare(
        `SELECT id FROM alerts
         WHERE website_id = ? AND title = ? AND created_at > datetime('now', '-1 day')
         LIMIT 1`
      )
      .get(website.id, title);
    if (recent) continue;
    if (days > 30) continue;

    const message = `${kind} certificate/registration for ${website.url} expires in ${days} day(s) (${expires}).`;
    db.prepare(
      `INSERT INTO alerts (user_id, website_id, url, message, severity, title, created_at)
       VALUES (?, ?, ?, ?, 'warning', ?, ?)`
    ).run(
      website.user_id,
      website.id,
      website.url,
      message,
      title,
      new Date().toISOString()
    );
    await notifyAlert({
      userId: website.user_id,
      websiteId: website.id,
      url: website.url,
      title,
      message,
      severity: 'warning',
    });
  }
}

/**
 * Run an uptime check with keyword, latency threshold, incidents, snapshots.
 */
async function runCheck(websiteId, { forceEmail = false } = {}) {
  const website = db.prepare('SELECT * FROM websites WHERE id = ?').get(websiteId);
  if (!website) throw new Error('Website not found');

  if (!website.slug) {
    db.prepare('UPDATE websites SET slug = ? WHERE id = ?').run(
      slugify(website.url, website.id),
      website.id
    );
  }

  const previousStatus = website.status;
  db.prepare(`UPDATE websites SET status = 'checking' WHERE id = ?`).run(websiteId);

  const probe = await probeMonitor(website);
  let status = probe.status;
  let responseMs = probe.responseMs;
  const statusCode = probe.statusCode;
  const checkedAt = new Date().toISOString();
  const monitorType = (website.monitor_type || 'http').toLowerCase();

  const threshold = website.response_threshold_ms
    ? Number(website.response_threshold_ms)
    : null;
  if (status === 'healthy' && threshold && responseMs != null && responseMs > threshold) {
    status = 'slow';
  }

  const insert = db
    .prepare(
      `INSERT INTO checks (website_id, status_code, response_ms, status, checked_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(websiteId, statusCode, responseMs, status, checkedAt);

  const checkId = insert.lastInsertRowid;

  db.prepare(`UPDATE websites SET status = ?, last_checked = ? WHERE id = ?`).run(
    status,
    checkedAt,
    websiteId
  );

  openOrResolveIncident(website, status, checkedAt);

  if (!isUp(status)) {
    db.prepare(
      `INSERT INTO failure_snapshots (website_id, check_id, body_snippet, headers_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      websiteId,
      checkId,
      (probe.body || probe.error || '').slice(0, 4000),
      JSON.stringify(probe.headers || {}),
      checkedAt
    );
  }

  let alert = null;
  const inMaintenance = isInMaintenance(website.user_id, websiteId);

  if ((!isUp(status) || status === 'slow') && !inMaintenance) {
    const owner = db
      .prepare('SELECT id, email, alert_email, name, alerts_enabled FROM users WHERE id = ?')
      .get(website.user_id);

    const { severity, title, message } = alertCopyFor(website, {
      status,
      responseMs,
      statusCode,
      threshold,
      probe,
    });

    const shouldNotify =
      forceEmail || shouldSendAlert(websiteId, previousStatus, status);

    const alertResult = db
      .prepare(
        `INSERT INTO alerts (user_id, website_id, url, message, severity, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(website.user_id, websiteId, website.url, message, severity, title, checkedAt);

    alert = {
      id: alertResult.lastInsertRowid,
      title,
      message,
      severity,
      created_at: checkedAt,
    };

    if (shouldNotify) {
      try {
        await notifyAlert({
          userId: website.user_id,
          websiteId,
          url: website.url,
          title,
          message,
          severity,
          ownerName: owner?.name,
          statusCode,
          skipMaintenanceCheck: true,
        });
      } catch (err) {
        console.error('[scanner] notify failed:', err.message);
      }
    }
  } else if (inMaintenance && !isUp(status)) {
    console.log(`[scanner] alert muted (maintenance) for ${website.url}`);
  }

  // SSL / domain expiry — HTTP monitors only
  if (monitorType === 'http') {
    try {
      await maybeCheckSslAndDomain(website);
    } catch (err) {
      console.warn('[scanner] ssl/domain check:', err.message);
    }
  }

  // Page tests: reuse the HTML already fetched — only when HTTP uptime succeeded
  let tests = [];
  if (monitorType === 'http' && isUp(status) && probe.body) {
    try {
      const pageResults = await runPageTests(probe.body, website.url, {
        websiteId,
      });
      const createdAt = new Date().toISOString();
      const insertTest = db.prepare(
        `INSERT INTO test_results (website_id, scan_id, test_type, status, summary, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const t of pageResults) {
        const r = insertTest.run(
          websiteId,
          checkId,
          t.test_type,
          t.status,
          t.summary,
          JSON.stringify(t.details || {}),
          createdAt
        );
        tests.push({
          id: r.lastInsertRowid,
          website_id: websiteId,
          scan_id: checkId,
          test_type: t.test_type,
          status: t.status,
          summary: t.summary,
          details: t.details || {},
          created_at: createdAt,
        });
      }
    } catch (err) {
      console.warn('[scanner] page tests failed:', err.message);
    }
  }

  const updated = db.prepare('SELECT * FROM websites WHERE id = ?').get(websiteId);
  const snapshot = db
    .prepare(
      `SELECT * FROM failure_snapshots WHERE website_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(websiteId);
  const openIncident = db
    .prepare(
      `SELECT * FROM incidents WHERE website_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`
    )
    .get(websiteId);

  return {
    check: {
      id: checkId,
      website_id: websiteId,
      status_code: statusCode,
      response_ms: responseMs,
      status,
      checked_at: checkedAt,
    },
    website: updated,
    alert,
    failure_snapshot: snapshot || null,
    open_incident: openIncident || null,
    tests,
  };
}

module.exports = { runCheck, slugify, probeSite, probeMonitor };
