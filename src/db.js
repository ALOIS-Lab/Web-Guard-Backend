const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'webguard.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS websites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    interval_min INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'checking',
    last_checked TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id INTEGER NOT NULL,
    status_code INTEGER,
    response_ms INTEGER,
    status TEXT NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    website_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
  );
`);

function ensureColumn(table, column, sqlType) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
  }
}

const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
if (!userCols.includes('alert_email')) {
  db.exec(`ALTER TABLE users ADD COLUMN alert_email TEXT`);
  db.exec(`UPDATE users SET alert_email = email WHERE alert_email IS NULL`);
}
ensureColumn('users', 'alerts_enabled', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'enabled_regions', 'TEXT');

ensureColumn('websites', 'owner_email', 'TEXT');
ensureColumn('websites', 'regions', 'TEXT');
ensureColumn('websites', 'keyword', 'TEXT');
ensureColumn('websites', 'response_threshold_ms', 'INTEGER');
ensureColumn('websites', 'tags', 'TEXT');
ensureColumn('websites', 'group_id', 'INTEGER');
ensureColumn('websites', 'slug', 'TEXT');
ensureColumn('websites', 'ssl_expires_at', 'TEXT');
ensureColumn('websites', 'domain_expires_at', 'TEXT');
ensureColumn('websites', 'last_ssl_check', 'TEXT');
ensureColumn('websites', 'last_domain_check', 'TEXT');
ensureColumn('websites', 'monitor_type', "TEXT NOT NULL DEFAULT 'http'");
ensureColumn('websites', 'monitor_config', 'TEXT');

ensureColumn('alerts', 'severity', "TEXT DEFAULT 'critical'");
ensureColumn('alerts', 'title', 'TEXT');

db.exec(`
  CREATE TABLE IF NOT EXISTS website_regions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id INTEGER NOT NULL,
    region TEXT NOT NULL,
    status TEXT NOT NULL,
    response_time INTEGER,
    status_code INTEGER,
    redirected INTEGER DEFAULT 0,
    ssl_ok INTEGER,
    dns_ok INTEGER DEFAULT 1,
    error TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_website_regions_site ON website_regions(website_id, checked_at DESC);

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    website_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    summary TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS maintenance_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    website_id INTEGER,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS integrations (
    user_id INTEGER PRIMARY KEY,
    slack_webhook_url TEXT,
    discord_webhook_url TEXT,
    custom_webhook_url TEXT,
    slack_enabled INTEGER NOT NULL DEFAULT 0,
    discord_enabled INTEGER NOT NULL DEFAULT 0,
    webhook_enabled INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    invite_token TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    member_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS failure_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id INTEGER NOT NULL,
    check_id INTEGER,
    body_snippet TEXT,
    headers_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id INTEGER NOT NULL,
    scan_id INTEGER,
    test_type TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
    FOREIGN KEY (scan_id) REFERENCES checks(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_test_results_site ON test_results(website_id, test_type, created_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_websites_slug ON websites(slug);
`);

// Backfill slugs for existing sites
const needSlug = db.prepare(`SELECT id, url FROM websites WHERE slug IS NULL OR slug = ''`).all();
for (const row of needSlug) {
  const base = String(row.url || 'site')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'site';
  let slug = `${base}-${row.id}`;
  db.prepare(`UPDATE websites SET slug = ? WHERE id = ?`).run(slug, row.id);
}

module.exports = db;
