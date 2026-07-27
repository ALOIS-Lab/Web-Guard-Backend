const net = require('net');
const dns = require('dns');
const { promisify } = require('util');
const { execFile } = require('child_process');

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 10000;
const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];

function makeResolver() {
  const resolver = new dns.Resolver();
  try {
    resolver.setServers(PUBLIC_DNS);
  } catch {
    /* keep system defaults */
  }
  return {
    resolve4: promisify(resolver.resolve4.bind(resolver)),
    resolve6: promisify(resolver.resolve6.bind(resolver)),
    resolveCname: promisify(resolver.resolveCname.bind(resolver)),
    resolveMx: promisify(resolver.resolveMx.bind(resolver)),
    resolveTxt: promisify(resolver.resolveTxt.bind(resolver)),
    resolveNs: promisify(resolver.resolveNs.bind(resolver)),
  };
}

function emptyProbe() {
  return {
    statusCode: null,
    responseMs: null,
    status: 'down',
    body: '',
    headers: {},
    error: null,
    redirected: false,
  };
}

/**
 * TCP connect check — databases, Redis, SSH, etc.
 * @param {{ host: string, port: number, timeoutMs?: number }} opts
 */
function probeTcp({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const result = emptyProbe();
    const socket = new net.Socket();
    let settled = false;

    const finish = (partial) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({
        ...result,
        responseMs: Date.now() - started,
        statusCode: port,
        ...partial,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ status: 'healthy', error: null }));
    socket.once('timeout', () => finish({ status: 'down', error: 'TCP connect timeout' }));
    socket.once('error', (err) =>
      finish({ status: 'down', error: err.message || 'TCP connection failed' })
    );

    try {
      socket.connect(Number(port), String(host));
    } catch (err) {
      finish({ status: 'down', error: err.message || 'TCP connection failed' });
    }
  });
}

/**
 * ICMP ping via OS ping binary (works without raw sockets / admin on Windows & Unix).
 * @param {{ host: string, timeoutMs?: number }} opts
 */
async function probeIcmp({ host, timeoutMs = DEFAULT_TIMEOUT_MS, packetCount = 1 }) {
  const started = Date.now();
  const result = emptyProbe();
  const target = String(host || '').trim();
  if (!target) {
    return { ...result, responseMs: 0, error: 'Host is required' };
  }

  const isWin = process.platform === 'win32';
  const count = Math.min(Math.max(Number(packetCount) || 1, 1), 10);
  const args = isWin
    ? ['-n', String(count), '-w', String(Math.min(timeoutMs, 30000))]
    : process.platform === 'darwin'
      ? ['-c', String(count), '-W', String(Math.ceil(timeoutMs / 1000) * 1000)]
      : ['-c', String(count), '-W', String(Math.ceil(timeoutMs / 1000))];

  try {
    const { stdout, stderr } = await execFileAsync('ping', [...args, target], {
      timeout: timeoutMs + 2000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const out = `${stdout || ''}\n${stderr || ''}`;
    const responseMs = Date.now() - started;

    const lost =
      /100% loss/i.test(out) ||
      /100% packet loss/i.test(out) ||
      /could not find host/i.test(out) ||
      /unknown host/i.test(out) ||
      /name or service not known/i.test(out);

    if (lost) {
      return { ...result, responseMs, error: 'No reply (100% packet loss)' };
    }

    // Prefer RTT from ping output when available
    let rtt = responseMs;
    const winMatch = out.match(/Average\s*=\s*(\d+)\s*ms/i) || out.match(/time[=<](\d+)\s*ms/i);
    const unixMatch = out.match(/time[=]([\d.]+)\s*ms/i);
    if (winMatch) rtt = Number(winMatch[1]);
    else if (unixMatch) rtt = Math.round(Number(unixMatch[1]));

    return { ...result, status: 'healthy', responseMs: rtt, error: null };
  } catch (err) {
    const responseMs = Date.now() - started;
    const msg = err?.stderr || err?.message || 'Ping failed';
    return {
      ...result,
      responseMs,
      error: String(msg).trim().slice(0, 500) || 'Ping failed',
    };
  }
}

function dnsResolversFor(resolver) {
  return {
    A: (name) => resolver.resolve4(name),
    AAAA: (name) => resolver.resolve6(name),
    CNAME: (name) => resolver.resolveCname(name),
    MX: async (name) => {
      const rows = await resolver.resolveMx(name);
      return rows.map((r) => `${r.exchange} (prio ${r.priority})`);
    },
    TXT: async (name) => {
      const rows = await resolver.resolveTxt(name);
      return rows.map((parts) => (Array.isArray(parts) ? parts.join('') : String(parts)));
    },
    NS: (name) => resolver.resolveNs(name),
  };
}

/**
 * DNS resolution + optional expected-record match (hijack / propagation detection).
 * @param {{ hostname: string, recordType?: string, expected?: string[], timeoutMs?: number }} opts
 */
async function probeDns({
  hostname,
  recordType = 'A',
  expected = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const started = Date.now();
  const result = emptyProbe();
  const name = String(hostname || '')
    .trim()
    .replace(/\.$/, '');
  const type = String(recordType || 'A').toUpperCase();

  if (!name) {
    return { ...result, responseMs: 0, error: 'Hostname is required' };
  }

  const resolvers = dnsResolversFor(makeResolver());
  const resolverFn = resolvers[type];
  if (!resolverFn) {
    return { ...result, responseMs: 0, error: `Unsupported DNS record type: ${type}` };
  }

  try {
    const records = await Promise.race([
      resolverFn(name),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('DNS lookup timeout')), timeoutMs);
      }),
    ]);
    const responseMs = Date.now() - started;
    const list = (Array.isArray(records) ? records : [records]).map((r) => String(r).toLowerCase());
    const expectedNorm = (expected || [])
      .map((e) => String(e).trim().toLowerCase())
      .filter(Boolean);

    result.headers = { 'x-dns-type': type, 'x-dns-records': list.join(', ') };
    result.body = list.join('\n');
    result.responseMs = responseMs;
    result.statusCode = list.length;

    if (expectedNorm.length > 0) {
      const missing = expectedNorm.filter((e) => !list.some((r) => r === e || r.includes(e)));
      if (missing.length > 0) {
        return {
          ...result,
          status: 'down',
          error: `DNS mismatch for ${type}: expected [${expectedNorm.join(', ')}], got [${list.join(', ')}]`,
        };
      }
    }

    if (list.length === 0) {
      return { ...result, status: 'down', error: `No ${type} records for ${name}` };
    }

    return { ...result, status: 'healthy', error: null };
  } catch (err) {
    return {
      ...result,
      responseMs: Date.now() - started,
      status: 'down',
      error: err?.code === 'ENOTFOUND' ? `NXDOMAIN / not found: ${name}` : err.message || 'DNS lookup failed',
    };
  }
}

function parseMonitorConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

module.exports = {
  probeTcp,
  probeIcmp,
  probeDns,
  parseMonitorConfig,
};