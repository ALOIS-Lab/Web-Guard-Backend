/** Catalog of Multi-Region Check locations (max 6). */
const REGIONS = [
  {
    id: 'us-east',
    name: 'North America',
    city: 'Virginia',
    label: 'North America (Virginia)',
    flag: '🇺🇸',
    latencyBaseMs: 40,
    latencyJitterMs: 35,
  },
  {
    id: 'eu-central',
    name: 'Europe',
    city: 'Frankfurt',
    label: 'Europe (Frankfurt)',
    flag: '🇩🇪',
    latencyBaseMs: 70,
    latencyJitterMs: 40,
  },
  {
    id: 'ap-southeast',
    name: 'Asia',
    city: 'Singapore',
    label: 'Asia (Singapore)',
    flag: '🇸🇬',
    latencyBaseMs: 120,
    latencyJitterMs: 55,
  },
  {
    id: 'ap-south',
    name: 'India',
    city: 'Mumbai',
    label: 'India (Mumbai)',
    flag: '🇮🇳',
    latencyBaseMs: 100,
    latencyJitterMs: 50,
  },
  {
    id: 'ap-southeast-2',
    name: 'Australia',
    city: 'Sydney',
    label: 'Australia (Sydney)',
    flag: '🇦🇺',
    latencyBaseMs: 160,
    latencyJitterMs: 60,
  },
  {
    id: 'sa-east',
    name: 'South America',
    city: 'São Paulo',
    label: 'South America (São Paulo)',
    flag: '🇧🇷',
    latencyBaseMs: 140,
    latencyJitterMs: 55,
  },
];

const DEFAULT_REGION_IDS = ['us-east', 'eu-central', 'ap-southeast'];
const ALL_REGION_IDS = REGIONS.map((r) => r.id);

function getRegion(id) {
  return REGIONS.find((r) => r.id === id) || null;
}

function parseRegionIds(raw, fallback = DEFAULT_REGION_IDS) {
  let list = fallback;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  const unique = [...new Set(list.filter((id) => ALL_REGION_IDS.includes(id)))];
  if (unique.length < 1) {
    return Array.isArray(fallback) ? [...fallback] : [...DEFAULT_REGION_IDS];
  }
  if (unique.length > 6) return unique.slice(0, 6);
  return unique;
}

function serializeRegionIds(ids) {
  return JSON.stringify(parseRegionIds(ids));
}

function overallFromRegional(results) {
  if (!results?.length) return 'checking';
  const healthy = results.filter((r) => r.status === 'healthy' || r.status === 'slow').length;
  const down = results.filter((r) => r.status === 'down' || r.status === 'timeout').length;
  if (down === 0 && healthy > 0) return 'healthy';
  if (healthy === 0 && down > 0) return 'down';
  if (healthy > 0 && down > 0) return 'partial';
  return 'checking';
}

function classifyLatency(ms, status) {
  if (status === 'down' || status === 'timeout') return status === 'timeout' ? 'timeout' : 'down';
  if (ms == null) return 'down';
  if (ms >= 800) return 'slow';
  return 'healthy';
}

module.exports = {
  REGIONS,
  DEFAULT_REGION_IDS,
  ALL_REGION_IDS,
  getRegion,
  parseRegionIds,
  serializeRegionIds,
  overallFromRegional,
  classifyLatency,
};
