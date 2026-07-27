const tls = require('tls');
const { URL } = require('url');

function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000));
}

async function getSslExpiry(siteUrl) {
  let hostname;
  try {
    const u = new URL(siteUrl);
    if (u.protocol !== 'https:') return null;
    hostname = u.hostname;
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, rejectUnauthorized: false },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          socket.end();
          if (cert && cert.valid_to) {
            resolve(new Date(cert.valid_to).toISOString());
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      }
    );
    socket.setTimeout(8000, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on('error', () => resolve(null));
  });
}

async function getDomainExpiry(siteUrl) {
  let hostname;
  try {
    hostname = new URL(siteUrl).hostname;
  } catch {
    return null;
  }

  // Prefer RDAP via rdap.org bootstrap
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(hostname)}`, {
      headers: { Accept: 'application/rdap+json, application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const events = data.events || [];
    const exp = events.find((e) => /expiration|expiry/i.test(e.eventAction || ''));
    if (exp?.eventDate) return new Date(exp.eventDate).toISOString();
  } catch {
    // ignore
  }
  return null;
}

const ALERT_THRESHOLDS = [30, 14, 7];

function shouldAlertExpiry(expiresAt, lastAlertDays) {
  const days = daysUntil(expiresAt);
  if (days == null) return null;
  for (const t of ALERT_THRESHOLDS) {
    if (days <= t && (lastAlertDays == null || lastAlertDays > t)) {
      return { days, threshold: t };
    }
  }
  return null;
}

module.exports = {
  getSslExpiry,
  getDomainExpiry,
  daysUntil,
  shouldAlertExpiry,
  ALERT_THRESHOLDS,
};
