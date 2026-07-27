const cheerio = require('cheerio');
const db = require('../db');

const LINK_TIMEOUT_MS = 5000;
const LINK_CONCURRENCY = 5;
const TECH_TIMEOUT_MS = 5000;
const TECH_CACHE_MS = 24 * 60 * 60 * 1000;
const PSI_TIMEOUT_MS = 45000;
const PSI_CACHE_MS = 8 * 60 * 60 * 1000; // 8h within 6–12h window
const USER_AGENT = 'WebGuard/1.0 (+monitor; audit)';
const SLOW_LINK_MS = 3000;
const MAX_REDIRECT_HOPS = 10;
const FRESHNESS_MONTHS = 12;

function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Best-effort site logo / favicon URL from page HTML (absolute).
 */
function extractSiteLogo(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const candidates = [];

  const push = (href) => {
    if (!href || typeof href !== 'string') return;
    const abs = resolveUrl(href.trim(), pageUrl);
    if (abs && /^https?:\/\//i.test(abs)) candidates.push(abs);
  };

  // Prefer apple-touch / large icons, then icon, then OG image, then /favicon.ico
  $('link[rel="apple-touch-icon"]').each((_, el) => push($(el).attr('href')));
  $('link[rel="apple-touch-icon-precomposed"]').each((_, el) => push($(el).attr('href')));
  $('link[rel="icon"]').each((_, el) => push($(el).attr('href')));
  $('link[rel="shortcut icon"]').each((_, el) => push($(el).attr('href')));
  push($('meta[property="og:image"]').attr('content'));
  push($('meta[name="twitter:image"]').attr('content'));

  try {
    candidates.push(new URL('/favicon.ico', pageUrl).toString());
  } catch {
    // ignore
  }

  // Prefer SVG/PNG over ICO when available; keep order but de-dupe
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    unique.push(c);
  }

  const scored = unique.map((url) => {
    const lower = url.toLowerCase();
    let score = 0;
    if (lower.includes('apple-touch')) score += 50;
    if (lower.endsWith('.png') || lower.includes('.png?')) score += 30;
    if (lower.endsWith('.svg') || lower.includes('.svg?')) score += 40;
    if (lower.endsWith('.webp')) score += 25;
    if (lower.endsWith('.ico') || lower.includes('favicon.ico')) score += 5;
    if (lower.includes('og:image') || lower.includes('/og')) score += 10;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.url || null;
}

function shouldSkipHref(href) {
  if (!href || typeof href !== 'string') return true;
  const trimmed = href.trim();
  if (!trimmed || trimmed === '#') return true;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('data:')
  ) {
    return true;
  }
  if (lower.startsWith('#')) return true;
  return false;
}

function gradeFromScore(score) {
  if (score == null || Number.isNaN(score)) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function statusFromScore(score) {
  if (score == null || Number.isNaN(score)) return 'warn';
  if (score >= 85) return 'pass';
  if (score >= 60) return 'warn';
  return 'fail';
}

function avgScores(scores) {
  const nums = scores.filter((s) => typeof s === 'number' && !Number.isNaN(s));
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function finding(severity, message, meta = {}) {
  return { severity, message, ...meta };
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: items.length ? n : 0 }, () => worker()));
  return results;
}

/**
 * Check one URL with manual redirect following (hop count + timing).
 */
async function checkOneLink(url, pageHost) {
  const started = Date.now();
  let current = url;
  let hops = 0;
  let statusCode = null;
  let error = null;
  let finalUrl = url;

  try {
    while (hops <= MAX_REDIRECT_HOPS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(current, {
          method: 'HEAD',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT },
        });
        if (response.status === 405 || response.status === 501) {
          response = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'User-Agent': USER_AGENT },
          });
        }
      } finally {
        clearTimeout(timeout);
      }

      statusCode = response.status;
      finalUrl = current;

      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const loc = response.headers.get('location');
        if (!loc) break;
        const nextUrl = resolveUrl(loc, current);
        if (!nextUrl) break;
        current = nextUrl;
        hops += 1;
        continue;
      }
      break;
    }
    if (hops > MAX_REDIRECT_HOPS) {
      error = 'Too many redirects';
    }
  } catch (err) {
    error = err?.name === 'AbortError' ? 'Timeout' : err.message || 'Request failed';
    statusCode = null;
  }

  const responseMs = Date.now() - started;
  const host = hostnameOf(finalUrl || url);
  const scope = host && host === pageHost ? 'internal' : 'external';
  const broken = Boolean(error) || statusCode == null || statusCode >= 400;
  const slow = !broken && responseMs > SLOW_LINK_MS;
  const manyRedirects = !broken && hops >= 4;

  return {
    url,
    finalUrl,
    statusCode,
    error,
    responseMs,
    redirectHops: hops,
    scope,
    broken,
    slow,
    manyRedirects,
  };
}

/**
 * Broken link checker — uses already-fetched HTML.
 */
async function runBrokenLinksTest(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const pageHost = hostnameOf(pageUrl);
  const unique = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (shouldSkipHref(href)) return;
    const absolute = resolveUrl(href, pageUrl);
    if (!absolute || !/^https?:\/\//i.test(absolute)) return;
    unique.add(absolute);
  });

  const urls = [...unique];
  if (urls.length === 0) {
    return {
      test_type: 'broken_links',
      status: 'pass',
      summary: 'No crawlable links found on the page.',
      details: {
        checked: 0,
        brokenCount: 0,
        internalCount: 0,
        externalCount: 0,
        brokenInternal: 0,
        brokenExternal: 0,
        slowCount: 0,
        redirectHeavyCount: 0,
        broken: [],
        slow: [],
        links: [],
      },
    };
  }

  const links = await mapPool(urls, LINK_CONCURRENCY, (u) => checkOneLink(u, pageHost));
  const broken = links.filter((l) => l.broken);
  const slow = links.filter((l) => l.slow);
  const redirectHeavy = links.filter((l) => l.manyRedirects);
  const internal = links.filter((l) => l.scope === 'internal');
  const external = links.filter((l) => l.scope === 'external');
  const brokenInternal = broken.filter((l) => l.scope === 'internal').length;
  const brokenExternal = broken.filter((l) => l.scope === 'external').length;

  const brokenCount = broken.length;
  const ratio = brokenCount / urls.length;
  let status = 'pass';
  if (brokenCount >= 1 && ratio <= 0.1) status = 'warn';
  if (ratio > 0.1 || brokenInternal >= 3) status = 'fail';
  if (status === 'pass' && (slow.length > 0 || redirectHeavy.length > 0)) status = 'warn';

  let summary;
  if (status === 'pass') {
    summary = `All ${urls.length} link(s) OK (${internal.length} internal · ${external.length} external).`;
  } else if (brokenCount) {
    summary = `${brokenCount} broken (${brokenInternal} internal · ${brokenExternal} external) of ${urls.length}.`;
  } else {
    summary = `${slow.length} slow and/or ${redirectHeavy.length} heavy-redirect link(s) detected.`;
  }

  const slim = (l) => ({
    url: l.url,
    finalUrl: l.finalUrl,
    statusCode: l.statusCode,
    error: l.error || null,
    responseMs: l.responseMs,
    redirectHops: l.redirectHops,
    scope: l.scope,
    broken: l.broken,
    slow: l.slow,
    manyRedirects: l.manyRedirects,
  });

  return {
    test_type: 'broken_links',
    status,
    summary,
    details: {
      checked: urls.length,
      brokenCount,
      internalCount: internal.length,
      externalCount: external.length,
      brokenInternal,
      brokenExternal,
      slowCount: slow.length,
      redirectHeavyCount: redirectHeavy.length,
      broken: broken.map(slim),
      slow: slow.map(slim),
      redirectHeavy: redirectHeavy.map(slim),
      links: links.map(slim),
    },
  };
}

async function fetchExists(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TECH_TIMEOUT_MS);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT },
      });
    }
    clearTimeout(timeout);
    return {
      unknown: false,
      exists: res.status >= 200 && res.status < 400,
      statusCode: res.status,
    };
  } catch {
    clearTimeout(timeout);
    return { unknown: true, exists: null, statusCode: null };
  }
}

function getCachedSeoCategory(websiteId, categoryKey, maxAgeMs) {
  if (!websiteId || !categoryKey) return null;
  try {
    const row = db
      .prepare(
        `SELECT details, created_at FROM test_results
         WHERE website_id = ? AND test_type = 'seo_basics'
         ORDER BY id DESC LIMIT 1`
      )
      .get(websiteId);
    if (!row?.details) return null;
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    const cat = details?.categories?.[categoryKey];
    if (!cat) return null;
    // Allow reuse when score was known, or when explicitly unknown but still fresh
    const checkedAt = cat.checkedAt || row.created_at;
    if (!checkedAt) return null;
    const age = Date.now() - new Date(checkedAt).getTime();
    if (Number.isNaN(age) || age > maxAgeMs) return null;
    return { ...cat, cached: true };
  } catch {
    return null;
  }
}

function getCachedTechnical(websiteId) {
  return getCachedSeoCategory(websiteId, 'technical', TECH_CACHE_MS);
}

async function auditTechnical(pageUrl, $, websiteId) {
  const cached = getCachedTechnical(websiteId);
  if (cached) return cached;

  const origin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return null;
    }
  })();

  const findings = [];
  const scoreParts = [];

  const viewport = $('meta[name="viewport"]').attr('content');
  if (viewport && String(viewport).trim()) {
    findings.push(finding('pass', 'Viewport meta tag is present.'));
    scoreParts.push(100);
  } else {
    findings.push(finding('warn', 'Missing <meta name="viewport"> (mobile signal).'));
    scoreParts.push(40);
  }

  const hasIconLink =
    $('link[rel="icon"]').length > 0 ||
    $('link[rel="shortcut icon"]').length > 0 ||
    $('link[rel="apple-touch-icon"]').length > 0;

  let favicon = { unknown: false, exists: hasIconLink, statusCode: null };
  if (!hasIconLink && origin) {
    favicon = await fetchExists(`${origin}/favicon.ico`);
  }
  if (favicon.unknown) {
    findings.push(finding('info', 'Favicon check timed out — excluded from score.'));
  } else if (favicon.exists) {
    findings.push(finding('pass', 'Favicon is present.'));
    scoreParts.push(100);
  } else {
    findings.push(finding('warn', 'No favicon detected (link or /favicon.ico).'));
    scoreParts.push(50);
  }

  let robots = { unknown: true };
  let sitemap = { unknown: true };
  if (origin) {
    [robots, sitemap] = await Promise.all([
      fetchExists(`${origin}/robots.txt`),
      fetchExists(`${origin}/sitemap.xml`),
    ]);
  }

  if (robots.unknown) {
    findings.push(finding('info', 'robots.txt check timed out — excluded from score.'));
  } else if (robots.exists) {
    findings.push(finding('pass', 'robots.txt is reachable.'));
    scoreParts.push(100);
  } else {
    findings.push(finding('warn', 'robots.txt not found at /robots.txt.'));
    scoreParts.push(55);
  }

  if (sitemap.unknown) {
    findings.push(finding('info', 'sitemap.xml check timed out — excluded from score.'));
  } else if (sitemap.exists) {
    findings.push(finding('pass', 'sitemap.xml is reachable.'));
    scoreParts.push(100);
  } else {
    findings.push(finding('warn', 'sitemap.xml not found at /sitemap.xml.'));
    scoreParts.push(55);
  }

  const score = avgScores(scoreParts);
  return {
    score,
    status: statusFromScore(score),
    findings,
    checkedAt: new Date().toISOString(),
    cached: false,
    robotsTxt: robots.unknown ? 'unknown' : robots.exists,
    sitemapXml: sitemap.unknown ? 'unknown' : sitemap.exists,
    viewport: Boolean(viewport && String(viewport).trim()),
    favicon: favicon.unknown ? 'unknown' : favicon.exists,
  };
}

function auditMeta($) {
  const findings = [];
  const scoreParts = [];

  const title = ($('title').first().text() || '').trim();
  const titleLength = title.length;
  if (!title) {
    findings.push(finding('fail', 'Missing <title> tag.'));
    scoreParts.push(0);
  } else if (titleLength < 30) {
    findings.push(finding('warn', `Title is short (${titleLength} chars; ideal ~30–60).`, { title }));
    scoreParts.push(70);
  } else if (titleLength > 60) {
    findings.push(finding('warn', `Title is long (${titleLength} chars; ideal ~30–60).`, { title }));
    scoreParts.push(70);
  } else {
    findings.push(finding('pass', `Title looks good (${titleLength} chars).`, { title }));
    scoreParts.push(100);
  }

  const metaDescription = (
    $('meta[name="description"]').attr('content') ||
    $('meta[name="Description"]').attr('content') ||
    ''
  ).trim();
  const descLen = metaDescription.length;
  if (!metaDescription) {
    findings.push(finding('warn', 'Missing meta description.'));
    scoreParts.push(40);
  } else if (descLen < 70) {
    findings.push(
      finding('warn', `Meta description is short (${descLen} chars; ideal ~70–160).`)
    );
    scoreParts.push(70);
  } else if (descLen > 160) {
    findings.push(
      finding('warn', `Meta description is long (${descLen} chars; ideal ~70–160).`)
    );
    scoreParts.push(70);
  } else {
    findings.push(finding('pass', `Meta description looks good (${descLen} chars).`));
    scoreParts.push(100);
  }

  const canonical =
    $('link[rel="canonical"]').attr('href') || $('link[rel="Canonical"]').attr('href') || null;
  if (canonical) {
    findings.push(finding('pass', 'Canonical link is present.', { canonical }));
    scoreParts.push(100);
  } else {
    findings.push(finding('info', 'No canonical link (informational).'));
    scoreParts.push(80);
  }

  const robots =
    $('meta[name="robots"]').attr('content') ||
    $('meta[name="Robots"]').attr('content') ||
    '';
  if (/noindex/i.test(robots)) {
    findings.push(
      finding('fail', `robots meta includes noindex ("${robots.trim()}") — page may be blocked from search.`)
    );
    scoreParts.push(0);
  } else if (robots) {
    findings.push(finding('pass', `robots meta: ${robots.trim()}`));
    scoreParts.push(100);
  } else {
    findings.push(finding('pass', 'No restrictive robots meta tag.'));
    scoreParts.push(100);
  }

  const lang = ($('html').attr('lang') || '').trim();
  if (lang) {
    findings.push(finding('pass', `html lang="${lang}" is set.`));
    scoreParts.push(100);
  } else {
    findings.push(finding('warn', 'Missing html lang attribute.'));
    scoreParts.push(60);
  }

  const score = avgScores(scoreParts);
  return {
    score,
    status: statusFromScore(score),
    findings,
    title: title || null,
    titleLength,
    metaDescription: metaDescription || null,
    metaDescriptionLength: descLen,
    canonical: Boolean(canonical),
    robots: robots || null,
    lang: lang || null,
  };
}

function auditHeadings($) {
  const findings = [];
  const scoreParts = [];
  const h1Count = $('h1').length;
  const outline = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const tag = String(el.name || el.tagName || '').toLowerCase();
    const level = Number(tag.replace('h', ''));
    const text = ($(el).text() || '').trim().slice(0, 120);
    if (level) outline.push({ level, text });
  });

  if (h1Count === 1) {
    findings.push(finding('pass', 'Exactly one H1 found.'));
    scoreParts.push(100);
  } else if (h1Count === 0) {
    findings.push(finding('warn', 'No H1 on the page.'));
    scoreParts.push(40);
  } else {
    findings.push(finding('warn', `Multiple H1 tags (${h1Count}).`));
    scoreParts.push(50);
  }

  let skipped = false;
  let prev = null;
  for (const item of outline) {
    if (prev != null && item.level > prev + 1) {
      skipped = true;
      findings.push(
        finding(
          'warn',
          `Heading level skips from H${prev} to H${item.level}${item.text ? ` (“${item.text}”)` : ''}.`
        )
      );
      break;
    }
    prev = item.level;
  }
  if (!skipped && outline.length) {
    findings.push(finding('pass', 'Heading levels do not skip.'));
    scoreParts.push(100);
  } else if (skipped) {
    scoreParts.push(55);
  } else {
    findings.push(finding('info', 'No heading outline to evaluate.'));
  }

  const hasH2 = outline.some((o) => o.level === 2);
  if (outline.length > 1 && !hasH2 && outline.some((o) => o.level >= 3)) {
    findings.push(finding('warn', 'Page uses deeper headings without H2.'));
    scoreParts.push(60);
  }

  const score = avgScores(scoreParts);
  return {
    score,
    status: statusFromScore(score),
    findings,
    h1Count,
    outline,
  };
}

function auditContent(html, $) {
  const findings = [];
  const scoreParts = [];
  const clone = cheerio.load(html || '');
  clone('script, style, noscript, svg').remove();
  const text = clone('body').text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const textLen = text.length;
  const htmlLen = (html || '').length || 1;
  const textHtmlRatio = Math.round((textLen / htmlLen) * 1000) / 10;

  if (wordCount < 150) {
    findings.push(
      finding('warn', `Thin content — about ${wordCount} visible words (under ~150).`)
    );
    scoreParts.push(wordCount < 50 ? 25 : 50);
  } else {
    findings.push(finding('pass', `Content length looks reasonable (~${wordCount} words).`));
    scoreParts.push(100);
  }

  if (textHtmlRatio < 10) {
    findings.push(
      finding('warn', `Low text-to-HTML ratio (${textHtmlRatio}%) — page may be code-heavy.`)
    );
    scoreParts.push(45);
  } else if (textHtmlRatio < 25) {
    findings.push(finding('info', `Text-to-HTML ratio is ${textHtmlRatio}%.`));
    scoreParts.push(75);
  } else {
    findings.push(finding('pass', `Text-to-HTML ratio is healthy (${textHtmlRatio}%).`));
    scoreParts.push(100);
  }

  const score = avgScores(scoreParts);
  return {
    score,
    status: statusFromScore(score),
    findings,
    wordCount,
    textHtmlRatio,
  };
}

function auditImages($) {
  const findings = [];
  const images = $('img');
  const totalImages = images.length;
  let missingAlt = 0;
  let missingDimensions = 0;
  images.each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt == null || String(alt).trim() === '') missingAlt += 1;
    const w = $(el).attr('width');
    const h = $(el).attr('height');
    if (w == null || h == null || String(w).trim() === '' || String(h).trim() === '') {
      missingDimensions += 1;
    }
  });

  if (totalImages === 0) {
    findings.push(finding('info', 'No images on the page.'));
    return { score: 100, status: 'pass', findings, totalImages: 0, missingAlt: 0, missingDimensions: 0 };
  }

  const altScore =
    missingAlt === 0 ? 100 : Math.max(0, Math.round(100 - (missingAlt / totalImages) * 100));
  const dimScore =
    missingDimensions === 0
      ? 100
      : Math.max(0, Math.round(100 - (missingDimensions / totalImages) * 70));

  if (missingAlt === 0) findings.push(finding('pass', `All ${totalImages} images have alt text.`));
  else
    findings.push(
      finding('warn', `${missingAlt} of ${totalImages} images are missing alt text.`)
    );

  if (missingDimensions === 0) {
    findings.push(finding('pass', 'All images declare width and height.'));
  } else {
    findings.push(
      finding(
        'warn',
        `${missingDimensions} of ${totalImages} images missing width/height (layout stability).`
      )
    );
  }

  const score = avgScores([altScore, dimScore]);
  return {
    score,
    status: statusFromScore(score),
    findings,
    totalImages,
    missingAlt,
    missingDimensions,
  };
}

function auditSocial($) {
  const findings = [];
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogDesc = $('meta[property="og:description"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  const twitterCard = $('meta[name="twitter:card"]').attr('content');

  const parts = [];
  if (ogTitle) {
    findings.push(finding('pass', 'og:title is set.'));
    parts.push(100);
  } else {
    findings.push(finding('warn', 'Missing og:title.'));
    parts.push(30);
  }
  if (ogDesc) {
    findings.push(finding('pass', 'og:description is set.'));
    parts.push(100);
  } else {
    findings.push(finding('warn', 'Missing og:description.'));
    parts.push(30);
  }
  if (ogImage) {
    findings.push(finding('pass', 'og:image is set.'));
    parts.push(100);
  } else {
    findings.push(finding('warn', 'Missing og:image.'));
    parts.push(30);
  }
  if (twitterCard) {
    findings.push(finding('pass', `twitter:card is set (${twitterCard}).`));
    parts.push(100);
  } else {
    findings.push(finding('warn', 'Missing twitter:card.'));
    parts.push(40);
  }

  const any = ogTitle || ogDesc || ogImage || twitterCard;
  if (!any) {
    findings.unshift(
      finding('warn', 'No Open Graph / Twitter Card tags — shares may look plain.')
    );
  }

  const score = avgScores(parts);
  return {
    score,
    status: statusFromScore(score),
    findings,
    ogTitle: Boolean(ogTitle),
    ogDescription: Boolean(ogDesc),
    ogImage: Boolean(ogImage),
    twitterCard: twitterCard || null,
  };
}

function auditLinksCategory(brokenDetails) {
  const findings = [];
  if (!brokenDetails) {
    return {
      score: null,
      status: 'warn',
      findings: [finding('info', 'Broken-link results unavailable — excluded from average.')],
    };
  }

  const checked = brokenDetails.checked || 0;
  const broken = brokenDetails.brokenCount || 0;
  const internal = brokenDetails.internalCount || 0;
  const external = brokenDetails.externalCount || 0;
  const brokenInternal = brokenDetails.brokenInternal || 0;
  const brokenExternal = brokenDetails.brokenExternal || 0;

  findings.push(
    finding('info', `${internal} internal · ${external} external links checked (${checked} total).`)
  );

  let score = 100;
  if (checked === 0) {
    findings.push(finding('info', 'No crawlable links to score.'));
    return { score: 100, status: 'pass', findings, internal, external, broken };
  }

  const ratio = broken / checked;
  if (broken === 0) {
    findings.push(finding('pass', 'No broken links detected.'));
    score = 100;
  } else if (brokenInternal > 0) {
    findings.push(
      finding(
        brokenInternal >= 3 || ratio > 0.1 ? 'fail' : 'warn',
        `${brokenInternal} broken internal and ${brokenExternal} broken external link(s).`
      )
    );
    score = Math.max(0, Math.round(100 - brokenInternal * 25 - brokenExternal * 8));
  } else {
    findings.push(finding('warn', `${brokenExternal} broken external link(s).`));
    score = Math.max(40, Math.round(100 - brokenExternal * 10));
  }

  if ((brokenDetails.slowCount || 0) > 0) {
    findings.push(
      finding('warn', `${brokenDetails.slowCount} link(s) responded slower than ${SLOW_LINK_MS}ms.`)
    );
    score = Math.max(0, score - brokenDetails.slowCount * 5);
  }

  return {
    score,
    status: statusFromScore(score),
    findings,
    internal,
    external,
    broken,
    brokenInternal,
    brokenExternal,
  };
}

function rootDomain(url) {
  const host = hostnameOf(url);
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

function cwvRating(metric, value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const v = Number(value);
  if (metric === 'lcp') {
    // value in ms
    if (v <= 2500) return 'good';
    if (v <= 4000) return 'needs-improvement';
    return 'poor';
  }
  if (metric === 'cls') {
    if (v <= 0.1) return 'good';
    if (v <= 0.25) return 'needs-improvement';
    return 'poor';
  }
  if (metric === 'inp') {
    // value in ms
    if (v <= 200) return 'good';
    if (v <= 500) return 'needs-improvement';
    return 'poor';
  }
  return null;
}

function ratingScore(rating) {
  if (rating === 'good') return 100;
  if (rating === 'needs-improvement') return 55;
  if (rating === 'poor') return 15;
  return null;
}

function extractPsiMetrics(data) {
  const field = data?.loadingExperience?.metrics || {};
  const audits = data?.lighthouseResult?.audits || {};

  let lcpMs =
    field.LARGEST_CONTENTFUL_PAINT_MS?.percentile ??
    audits['largest-contentful-paint']?.numericValue ??
    null;
  let cls =
    field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
      ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
      : audits['cumulative-layout-shift']?.numericValue ?? null;
  let inpMs =
    field.INTERACTION_TO_NEXT_PAINT?.percentile ??
    audits['interaction-to-next-paint']?.numericValue ??
    audits['experimental-interaction-to-next-paint']?.numericValue ??
    null;

  if (lcpMs != null) lcpMs = Math.round(Number(lcpMs));
  if (cls != null) cls = Math.round(Number(cls) * 1000) / 1000;
  if (inpMs != null) inpMs = Math.round(Number(inpMs));

  return { lcpMs, cls, inpMs };
}

/**
 * Core Web Vitals via PageSpeed Insights — cached ~8h.
 */
async function auditPageSpeed(pageUrl, websiteId) {
  const cached = getCachedSeoCategory(websiteId, 'pageSpeed', PSI_CACHE_MS);
  if (cached) return cached;

  const unknown = (message) => ({
    score: null,
    status: 'warn',
    findings: [finding('info', message)],
    unknown: true,
    checkedAt: new Date().toISOString(),
    cached: false,
    lcp: null,
    cls: null,
    inp: null,
  });

  try {
    const key = process.env.PAGESPEED_API_KEY || process.env.GOOGLE_API_KEY || '';
    let endpoint =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
      `?url=${encodeURIComponent(pageUrl)}` +
      `&category=PERFORMANCE&strategy=mobile`;
    if (key) endpoint += `&key=${encodeURIComponent(key)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(endpoint, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      return unknown(`PageSpeed API returned HTTP ${res.status} — excluded from score.`);
    }
    const data = await res.json();
    if (data.error) {
      return unknown(
        `PageSpeed API error: ${data.error.message || 'unknown'} — excluded from score.`
      );
    }

    const { lcpMs, cls, inpMs } = extractPsiMetrics(data);
    const lcpRating = cwvRating('lcp', lcpMs);
    const clsRating = cwvRating('cls', cls);
    const inpRating = cwvRating('inp', inpMs);

    const findings = [];
    const parts = [];

    if (lcpRating) {
      findings.push(
        finding(
          lcpRating === 'good' ? 'pass' : lcpRating === 'poor' ? 'fail' : 'warn',
          `LCP ${(lcpMs / 1000).toFixed(2)}s — ${lcpRating.replace('-', ' ')} (good ≤2.5s).`
        )
      );
      parts.push(ratingScore(lcpRating));
    } else {
      findings.push(finding('info', 'LCP unavailable from PageSpeed for this URL.'));
    }

    if (clsRating) {
      findings.push(
        finding(
          clsRating === 'good' ? 'pass' : clsRating === 'poor' ? 'fail' : 'warn',
          `CLS ${cls} — ${clsRating.replace('-', ' ')} (good ≤0.1).`
        )
      );
      parts.push(ratingScore(clsRating));
    } else {
      findings.push(finding('info', 'CLS unavailable from PageSpeed for this URL.'));
    }

    if (inpRating) {
      findings.push(
        finding(
          inpRating === 'good' ? 'pass' : inpRating === 'poor' ? 'fail' : 'warn',
          `INP ${inpMs}ms — ${inpRating.replace('-', ' ')} (good ≤200ms).`
        )
      );
      parts.push(ratingScore(inpRating));
    } else {
      findings.push(finding('info', 'INP unavailable from PageSpeed for this URL.'));
    }

    const score = avgScores(parts);
    if (score == null) {
      return unknown('PageSpeed returned no Core Web Vitals metrics — excluded from score.');
    }

    return {
      score,
      status: statusFromScore(score),
      findings,
      unknown: false,
      checkedAt: new Date().toISOString(),
      cached: false,
      lcp: lcpMs != null ? { valueMs: lcpMs, rating: lcpRating } : null,
      cls: cls != null ? { value: cls, rating: clsRating } : null,
      inp: inpMs != null ? { valueMs: inpMs, rating: inpRating } : null,
    };
  } catch (err) {
    const msg =
      err?.name === 'AbortError'
        ? 'PageSpeed API timed out — excluded from score.'
        : `PageSpeed check failed (${err.message}) — excluded from score.`;
    return unknown(msg);
  }
}

function collectJsonLdTypes(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdTypes(item, out);
    return;
  }
  if (node['@type']) {
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    for (const t of types) {
      if (t && !out.includes(String(t))) out.push(String(t));
    }
  }
  if (node['@graph']) collectJsonLdTypes(node['@graph'], out);
}

function auditStructuredData($) {
  const types = [];
  const parseErrors = [];
  let blocks = 0;

  $('script[type="application/ld+json"]').each((_, el) => {
    blocks += 1;
    const raw = ($(el).html() || '').trim();
    if (!raw) {
      parseErrors.push('Empty JSON-LD script block');
      return;
    }
    try {
      const data = JSON.parse(raw);
      collectJsonLdTypes(data, types);
    } catch (err) {
      parseErrors.push(err.message || 'Invalid JSON');
    }
  });

  const findings = [];
  let score;
  let status;

  if (parseErrors.length > 0) {
    status = 'fail';
    score = 20;
    findings.push(
      finding(
        'fail',
        `${parseErrors.length} JSON-LD block(s) failed to parse — invalid structured data on the page.`
      )
    );
    for (const e of parseErrors.slice(0, 3)) {
      findings.push(finding('fail', `Parse error: ${e}`));
    }
  } else if (types.length > 0) {
    status = 'pass';
    score = 100;
    findings.push(
      finding('pass', `Structured data found: ${types.join(', ')}.`)
    );
  } else if (blocks === 0) {
    status = 'warn';
    score = 70;
    findings.push(
      finding('warn', 'No JSON-LD structured data found (nice to have, not critical).')
    );
  } else {
    status = 'warn';
    score = 75;
    findings.push(
      finding('warn', 'JSON-LD present but no recognizable @type values.')
    );
  }

  return {
    score,
    status,
    findings,
    present: types.length > 0,
    types,
    parseErrors,
  };
}

function auditDuplicateContent(websiteId, pageUrl, title, metaDescription) {
  if (!websiteId) return null;

  const site = db.prepare('SELECT id, user_id, url FROM websites WHERE id = ?').get(websiteId);
  if (!site) return null;

  const root = rootDomain(pageUrl || site.url);
  if (!root) return null;

  const siblings = db
    .prepare(`SELECT id, url FROM websites WHERE user_id = ? AND id != ?`)
    .all(site.user_id, websiteId)
    .filter((w) => rootDomain(w.url) === root);

  if (siblings.length === 0) return null; // omit category entirely

  const titleNorm = (title || '').trim().toLowerCase();
  const descNorm = (metaDescription || '').trim().toLowerCase();
  const duplicateTitleWith = [];
  const duplicateDescriptionWith = [];

  for (const sib of siblings) {
    const row = db
      .prepare(
        `SELECT details FROM test_results
         WHERE website_id = ? AND test_type = 'seo_basics'
         ORDER BY id DESC LIMIT 1`
      )
      .get(sib.id);
    if (!row?.details) continue;
    let details;
    try {
      details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    } catch {
      continue;
    }
    const otherTitle = (details?.categories?.meta?.title || '').trim().toLowerCase();
    const otherDesc = (details?.categories?.meta?.metaDescription || '').trim().toLowerCase();
    if (titleNorm && otherTitle && titleNorm === otherTitle) {
      duplicateTitleWith.push(sib.url);
    }
    if (descNorm && otherDesc && descNorm === otherDesc) {
      duplicateDescriptionWith.push(sib.url);
    }
  }

  const findings = [];
  let score = 100;
  let status = 'pass';

  if (duplicateTitleWith.length) {
    status = 'warn';
    score = Math.min(score, 45);
    findings.push(
      finding(
        'warn',
        `Identical <title> shared with ${duplicateTitleWith.length} other page(s) on ${root}.`
      )
    );
  }
  if (duplicateDescriptionWith.length) {
    status = 'warn';
    score = Math.min(score, 50);
    findings.push(
      finding(
        'warn',
        `Identical meta description shared with ${duplicateDescriptionWith.length} other page(s) on ${root}.`
      )
    );
  }
  if (!duplicateTitleWith.length && !duplicateDescriptionWith.length) {
    findings.push(
      finding('pass', `No duplicate titles/descriptions vs other monitored pages on ${root}.`)
    );
  }

  return {
    score,
    status,
    findings,
    duplicateTitleWith,
    duplicateDescriptionWith,
    comparedAgainst: siblings.length,
  };
}

function auditFreshness($) {
  const findings = [];
  const candidates = [];

  const pushDate = (raw, source) => {
    if (!raw) return;
    const d = new Date(String(raw).trim());
    if (!Number.isNaN(d.getTime())) candidates.push({ date: d, source, raw: String(raw).trim() });
  };

  pushDate($('meta[property="article:modified_time"]').attr('content'), 'article:modified_time');
  pushDate($('meta[property="article:published_time"]').attr('content'), 'article:published_time');
  pushDate($('meta[name="last-modified"]').attr('content'), 'last-modified');
  pushDate($('meta[http-equiv="last-modified"]').attr('content'), 'http-equiv last-modified');
  $('time[datetime]').each((_, el) => {
    pushDate($(el).attr('datetime'), 'time[datetime]');
  });

  if (!candidates.length) {
    findings.push(
      finding(
        'info',
        'No machine-readable freshness date found (normal for many page types — not scored).'
      )
    );
    return {
      score: null,
      status: 'pass',
      informational: true,
      findings,
      date: null,
      stale: false,
    };
  }

  candidates.sort((a, b) => b.date - a.date);
  const newest = candidates[0];
  const ageMs = Date.now() - newest.date.getTime();
  const months = ageMs / (30.44 * 24 * 60 * 60 * 1000);
  const iso = newest.date.toISOString().slice(0, 10);

  if (months > FRESHNESS_MONTHS) {
    findings.push(
      finding(
        'warn',
        `Content date looks stale (${iso} via ${newest.source}) — older than ~${FRESHNESS_MONTHS} months.`
      )
    );
    return {
      score: null,
      status: 'warn',
      informational: true,
      findings,
      date: iso,
      source: newest.source,
      stale: true,
    };
  }

  findings.push(
    finding('info', `Freshness signal present (${iso} via ${newest.source}) — informational only.`)
  );
  return {
    score: null,
    status: 'pass',
    informational: true,
    findings,
    date: iso,
    source: newest.source,
    stale: false,
  };
}

/**
 * Full SEO audit — reuses HTML; technical (~24h) + PageSpeed (~8h) cached.
 */
async function runSeoBasicsTest(html, pageUrl, { websiteId, brokenDetails } = {}) {
  const $ = cheerio.load(html || '');

  const meta = auditMeta($);
  const headings = auditHeadings($);
  const content = auditContent(html, $);
  const images = auditImages($);
  const social = auditSocial($);
  const technical = await auditTechnical(pageUrl, $, websiteId);
  const links = auditLinksCategory(brokenDetails);
  const pageSpeed = await auditPageSpeed(pageUrl, websiteId);
  const structuredData = auditStructuredData($);
  const duplicateContent = auditDuplicateContent(
    websiteId,
    pageUrl,
    meta.title,
    meta.metaDescription
  );
  const freshness = auditFreshness($);

  const categories = {
    pageSpeed,
    meta,
    headings,
    content,
    images,
    social,
    structuredData,
    technical,
    links,
  };
  if (duplicateContent) categories.duplicateContent = duplicateContent;
  // freshness is informational — stored separately, not in scored average
  categories.freshness = freshness;

  const scoredCats = Object.entries(categories)
    .filter(([key, c]) => key !== 'freshness' && c && typeof c.score === 'number')
    .map(([, c]) => c.score);

  const overallScore = avgScores(scoredCats);
  const grade = gradeFromScore(overallScore);
  const status = !meta.title ? 'fail' : statusFromScore(overallScore);

  const scoredEntries = Object.entries(categories).filter(([key]) => key !== 'freshness');
  const warnCount = scoredEntries.filter(([, c]) => c?.status === 'warn').length;
  const failCount = scoredEntries.filter(([, c]) => c?.status === 'fail').length;
  const siteLogo = extractSiteLogo(html, pageUrl);

  let summary;
  if (overallScore == null) {
    summary = 'SEO audit incomplete.';
  } else if (status === 'pass') {
    summary = `SEO score ${overallScore}/100 (grade ${grade}).`;
  } else {
    summary = `SEO score ${overallScore}/100 (grade ${grade}) — ${failCount} fail · ${warnCount} warn categories.`;
  }

  return {
    test_type: 'seo_basics',
    status,
    summary,
    details: {
      overallScore,
      grade,
      siteLogo,
      siteUrl: pageUrl,
      categories,
    },
  };
}

async function runPageTests(html, pageUrl, { websiteId } = {}) {
  const results = [];
  let broken = null;
  try {
    broken = await runBrokenLinksTest(html, pageUrl);
    results.push(broken);
  } catch (err) {
    broken = {
      test_type: 'broken_links',
      status: 'warn',
      summary: `Broken link check could not finish: ${err.message}`,
      details: { error: err.message, broken: [], checked: 0 },
    };
    results.push(broken);
  }
  try {
    results.push(
      await runSeoBasicsTest(html, pageUrl, {
        websiteId,
        brokenDetails: broken?.details || null,
      })
    );
  } catch (err) {
    results.push({
      test_type: 'seo_basics',
      status: 'warn',
      summary: `SEO audit could not finish: ${err.message}`,
      details: { error: err.message },
    });
  }
  return results;
}

module.exports = {
  runPageTests,
  runBrokenLinksTest,
  runSeoBasicsTest,
  gradeFromScore,
};
