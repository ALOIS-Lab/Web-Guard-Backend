/**
 * RegionChecker provider abstraction.
 * Today: simulated multi-region probes from this server (latency shaping).
 * Later: swap createRegionChecker() implementations for real edge workers.
 */

const { getRegion, classifyLatency } = require('../regions');

/**
 * @typedef {{
 *   region: string,
 *   status: 'healthy'|'slow'|'down'|'timeout',
 *   response_ms: number|null,
 *   status_code: number|null,
 *   redirected: boolean,
 *   ssl_ok: boolean|null,
 *   dns_ok: boolean,
 *   error: string|null,
 * }} RegionCheckResult
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeUrl(url, { timeoutMs = 12000 } = {}) {
  const started = Date.now();
  let statusCode = null;
  let redirected = false;
  let sslOk = null;
  let dnsOk = true;
  let error = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'WebGuard-MultiRegion/1.0 (+monitor)' },
    });
    clearTimeout(timeout);

    statusCode = response.status;
    redirected = response.status >= 300 && response.status < 400;

    // Follow one redirect for final status if needed
    let final = response;
    if (redirected) {
      const loc = response.headers.get('location');
      if (loc) {
        try {
          const nextUrl = new URL(loc, url).toString();
          const controller2 = new AbortController();
          const t2 = setTimeout(() => controller2.abort(), timeoutMs);
          final = await fetch(nextUrl, {
            method: 'GET',
            redirect: 'follow',
            signal: controller2.signal,
            headers: { 'User-Agent': 'WebGuard-MultiRegion/1.0 (+monitor)' },
          });
          clearTimeout(t2);
          statusCode = final.status;
        } catch (err) {
          error = err.message;
        }
      }
    }

    if (url.startsWith('https:')) {
      sslOk = true;
    } else {
      sslOk = null;
    }

    const ok = statusCode != null && statusCode >= 200 && statusCode < 400;
    return {
      ok,
      statusCode,
      redirected,
      sslOk,
      dnsOk,
      responseMs: Date.now() - started,
      error: ok ? null : error || `HTTP ${statusCode}`,
    };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Timeout' : err.message || 'Connection failed';
    if (/ENOTFOUND|getaddrinfo|DNS/i.test(msg)) dnsOk = false;
    return {
      ok: false,
      statusCode: null,
      redirected: false,
      sslOk: url.startsWith('https:') ? false : null,
      dnsOk,
      responseMs: Date.now() - started,
      error: msg,
      timedOut: /timeout/i.test(msg) || err?.name === 'AbortError',
    };
  }
}

/**
 * Simulated regional checker — real HTTPS probe + region latency profile.
 * Replace with edge-deployed checkers later without changing callers.
 */
function createSimulatedRegionChecker(regionId) {
  const meta = getRegion(regionId);
  if (!meta) {
    throw new Error(`Unknown region: ${regionId}`);
  }

  return {
    region: regionId,
    meta,
    /**
     * @param {string} url
     * @returns {Promise<RegionCheckResult>}
     */
    async check(url) {
      const probe = await probeUrl(url);
      const jitter = Math.floor(Math.random() * (meta.latencyJitterMs + 1));
      const shapedMs = probe.responseMs + meta.latencyBaseMs + jitter;

      // Tiny optional regional flakiness (disabled unless SIMULATE_REGIONAL_FAILS=1)
      let forcedFail = false;
      if (process.env.SIMULATE_REGIONAL_FAILS === '1') {
        const failChance = Number(process.env.SIMULATE_FAIL_CHANCE || 0.08);
        forcedFail = Math.random() < failChance;
      }

      if (forcedFail || probe.timedOut) {
        await sleep(20);
        return {
          region: regionId,
          status: 'timeout',
          response_ms: null,
          status_code: null,
          redirected: false,
          ssl_ok: probe.sslOk,
          dns_ok: probe.dnsOk,
          error: forcedFail ? `Simulated regional timeout from ${meta.city}` : probe.error,
        };
      }

      if (!probe.ok) {
        return {
          region: regionId,
          status: 'down',
          response_ms: shapedMs,
          status_code: probe.statusCode,
          redirected: probe.redirected,
          ssl_ok: probe.sslOk,
          dns_ok: probe.dnsOk,
          error: probe.error,
        };
      }

      const status = classifyLatency(shapedMs, 'healthy');
      return {
        region: regionId,
        status,
        response_ms: shapedMs,
        status_code: probe.statusCode,
        redirected: probe.redirected,
        ssl_ok: probe.sslOk,
        dns_ok: probe.dnsOk,
        error: null,
      };
    },
  };
}

function getCheckersForRegions(regionIds) {
  return regionIds.map((id) => createSimulatedRegionChecker(id));
}

module.exports = {
  createSimulatedRegionChecker,
  getCheckersForRegions,
  probeUrl,
};
