const cron = require('node-cron');
const db = require('../db');
const { runCheck } = require('./scanner');

function minutesElapsed(lastChecked) {
  if (!lastChecked) return Infinity;
  const then = new Date(lastChecked).getTime();
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / 60000;
}

async function tick() {
  const sites = db
    .prepare(
      `SELECT id, url, interval_min, last_checked, monitor_type FROM websites
       WHERE COALESCE(monitor_type, 'http') = 'http'`
    )
    .all();
  const due = sites.filter((s) => minutesElapsed(s.last_checked) >= Number(s.interval_min || 5));

  for (const site of due) {
    try {
      await runCheck(site.id);
      console.log(`[scheduler] checked ${site.url}`);
    } catch (err) {
      console.error(`[scheduler] error checking ${site.url}:`, err.message);
    }
  }
}

function startScheduler() {
  // Every 30s so sub-minute intervals (e.g. 0.5 min) can fire on time
  cron.schedule('*/30 * * * * *', () => {
    tick().catch((err) => console.error('[scheduler] tick failed:', err.message));
  });
  console.log('[scheduler] started — checking due monitors every 30 seconds');
}

module.exports = { startScheduler, tick };
