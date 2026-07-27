/**
 * WebGuard AI Support — knowledge base + optional OpenAI.
 * Works 24/7 without an API key via local smart matching;
 * set OPENAI_API_KEY for generative replies.
 */

const KNOWLEDGE = [
  {
    id: 'greeting',
    phrases: ['hello', 'hi', 'hey', 'good morning', 'good evening', 'help me', 'i need help'],
    keywords: ['hello', 'hi', 'hey', 'help'],
    answer:
      "Hi! I'm WebGuard Support — available 24/7. I can help with website monitors (HTTP/HTTPS), SEO testing, scans, alerts, reports, schedules, and your account. What would you like to do?",
  },
  {
    id: 'product',
    phrases: ['what is webguard', 'what does webguard', 'about webguard', 'who are you'],
    keywords: ['webguard', 'product', 'about'],
    answer:
      'WebGuard monitors websites around the clock. Add HTTP/HTTPS website monitors, and WebGuard tracks uptime, response time, and alerts you by email when something fails. Tagline: Monitor. Protect. Assure.',
  },
  {
    id: 'seo',
    phrases: [
      'seo testing',
      'seo test',
      'check seo',
      'how to check seo',
      'seo score',
      'seo basics',
      'run seo',
      'seo page',
      'where is seo',
    ],
    keywords: ['seo', 'meta', 'pagespeed', 'structured data', 'canonical'],
    answer:
      'To run SEO testing:\n1) Sign in and open SEO Testing in the top navigation (or go to /app/seo).\n2) Add at least one website under Monitors if you have none yet.\n3) Click Scan now on that site (or wait for the schedule) so WebGuard can fetch the page.\n4) Return to SEO Testing to see the score, grade, and category results (meta tags, headings, PageSpeed, structured data, freshness, and more).',
  },
  {
    id: 'monitors',
    phrases: [
      'create monitor',
      'add monitor',
      'monitor website',
      'what can i monitor',
      'http monitor',
      'https monitor',
    ],
    keywords: ['monitor', 'website', 'https', 'http'],
    answer:
      'Open Monitors → Create monitor. Enter an HTTP or HTTPS URL, owner email, and check interval, then Start Monitoring. Use Scan now anytime for an immediate uptime check.',
  },
  {
    id: 'add-website',
    phrases: ['add website', 'add a website', 'add site', 'first website', 'monitor url'],
    keywords: ['website', 'url', 'add'],
    answer:
      'Go to Monitors → Create monitor → choose HTTP Website. Enter the URL (https:// is added if missing), owner email, and check interval, then Start Monitoring. Use Scan now on any row for an immediate check.',
  },
  {
    id: 'scan',
    phrases: ['scan now', 'manual scan', 'run a scan', 'how do scans work', 'broken links'],
    keywords: ['scan', 'scans', 'uptime'],
    answer:
      'A scan probes your target and saves status + response time.\n• From Monitors: click Scan now on a row\n• Or open Scans for recent results and broken-link findings on HTTP sites\nHistory also feeds Reports and SEO Testing (for HTTP monitors).',
  },
  {
    id: 'uptime',
    phrases: ['uptime', 'availability', 'is my site up', 'health check', 'monitor health', 'is it down'],
    keywords: ['uptime', 'availability', 'health', 'down', 'slow', 'response time', 'scan'],
    answer:
      'WebGuard availability checks run as scans on each monitor.\n• When you add a website, WebGuard fetches it on the selected interval\n• If it’s slow, it becomes `slow`; if it fails, it becomes `down`\n• You can see the latest status in Monitors and the history in Scans and Reports.',
  },
  {
    id: 'schedule',
    phrases: ['check interval', 'how often', 'change schedule', 'schedules page'],
    keywords: ['schedule', 'interval', 'minutes', 'cron'],
    answer:
      'Each monitor has a check interval (30 sec up to 1 hour). Set it when creating a monitor, or adjust later on Schedules. The server checks due monitors every 30 seconds.',
  },
  {
    id: 'alerts',
    phrases: ['how do alerts work', 'email alert', 'down alert', 'notifications'],
    keywords: ['alert', 'alerts', 'email', 'notification', 'smtp'],
    answer:
      'When a check fails (or is slow), WebGuard creates an alert under Alerts and can email the owner if SMTP is configured on the API. Make sure the monitor has a valid owner email. Open Alerts to review history.',
  },
  {
    id: 'reports',
    phrases: ['view reports', 'uptime report', 'response time'],
    keywords: ['report', 'reports', 'uptime', 'latency', 'stats'],
    answer:
      'Open Reports to see uptime % and average response time from real scan history. If it’s empty, run at least one Scan now on a monitor first — nothing is fabricated.',
  },
  {
    id: 'dashboard',
    phrases: ['dashboard overview', 'getting started', 'radar'],
    keywords: ['dashboard', 'radar', 'healthy', 'failed', 'slow'],
    answer:
      'Dashboard shows Total, Healthy, Slow, Failed, and In Progress from your live monitors, plus a radar of site status. With zero monitors you’ll see a short getting-started guide. Shortcut cards jump to Monitors, Scans, Reports, and more.',
  },
  {
    id: 'dark-mode',
    phrases: ['dark mode', 'light mode', 'change theme'],
    keywords: ['theme', 'appearance', 'dark'],
    answer:
      'Toggle light/dark with the sun/moon button in the header. In Settings → Appearance you can choose Light, Dark, or System. Your preference is saved in the browser.',
  },
  {
    id: 'signup',
    phrases: ['sign up', 'create account', 'register', 'new account'],
    keywords: ['signup', 'register'],
    answer:
      'Open Sign Up, enter your name, email, and a strong password. After signup you land in the app — create your first monitor from Monitors or the dashboard guide.',
  },
  {
    id: 'login',
    phrases: ['sign in', 'log in', 'login', 'forgot password', 'change password'],
    keywords: ['login', 'password', 'signin'],
    requireAny: ['login', 'signin', 'sign in', 'log in', 'password', 'forgot', 'register', 'account'],
    answer:
      'Use Sign In with the email and password you registered. To change your password later: open Settings after logging in, enter a new password, and save (leave blank to keep the current one).',
  },
  {
    id: 'settings',
    phrases: ['update profile', 'change email', 'account settings'],
    keywords: ['settings', 'profile'],
    answer:
      'Open Settings to update your name, email, password, and appearance (theme). Changes apply after you click Save.',
  },
  {
    id: 'pricing',
    phrases: ['upgrade to pro', 'pricing plans', 'free plan'],
    keywords: ['pro', 'upgrade', 'billing', 'price', 'pricing', 'plan', 'free'],
    answer:
      'WebGuard has a free forever plan for core monitoring — no credit card required. Open Pricing (or Upgrade in the header) for Free / Pro / Advanced. Contact support if you need enterprise options.',
  },
  {
    id: 'integrations',
    phrases: ['slack integration', 'webhook', 'push notifications'],
    keywords: ['integration', 'slack', 'webhook', 'push'],
    answer:
      'Open Integrations to manage notification channels. Email alerts work when SMTP is configured. Push/webhook options appear there when enabled for your account.',
  },
  {
    id: 'groups',
    phrases: ['website groups', 'organize sites'],
    keywords: ['group', 'groups', 'tags'],
    answer:
      'Use Groups (under More in the nav) to organize monitors. You can also filter and manage related sites from the Monitors area.',
  },
  {
    id: 'ssl',
    phrases: ['ssl expiry', 'certificate', 'domain expiry'],
    keywords: ['ssl', 'certificate', 'domain'],
    answer:
      'For HTTP monitors, WebGuard tracks SSL and domain expiry on the site detail page and can alert when dates approach. Open a monitor’s detail view to see SSL / domain expiry dates.',
  },
  {
    id: 'status-page',
    phrases: ['status page', 'public status', 'status link'],
    keywords: ['status'],
    answer:
      'Each HTTP monitor can have a public status page. Open the monitor detail → Copy status link or Open status page to share uptime with others.',
  },
  {
    id: 'api',
    phrases: ['api token', 'jwt auth', 'api routes'],
    keywords: ['api', 'jwt', 'token'],
    answer:
      'The API uses JWT Bearer tokens after signup/login. Main routes: /api/websites (monitors), /api/scans, /api/alerts, /api/support/chat. Support chat works without login so visitors can get help first.',
  },
  {
    id: 'troubleshoot',
    phrases: ['not working', 'something broken', 'scan failed', 'no email'],
    keywords: ['error', 'fail', 'broken', 'bug', 'issue'],
    answer:
      'Quick checks:\n1) Is the API running on http://localhost:4000?\n2) Is the app open on http://localhost:5173?\n3) For email alerts: SMTP vars set in backend/.env?\n4) Does your target URL/host open outside WebGuard?\nTell me which page you were on and what you clicked — I’ll narrow it down.',
  },
  {
    id: 'contact',
    phrases: ['talk to human', 'contact support', 'support hours'],
    keywords: ['contact', 'human', 'agent'],
    answer:
      'This assistant is available 24/7 inside WebGuard. For account-specific issues, reply with your email and a short description of the problem.',
  },
  {
    id: 'thanks',
    phrases: ['thank you', 'thanks', 'bye', 'goodbye'],
    keywords: ['thank', 'thanks', 'bye', 'goodbye'],
    answer: "You're welcome! I'm here anytime — WebGuard Support runs 24/7. Happy monitoring!",
  },
];

const SYSTEM_PROMPT = `You are WebGuard Support, a friendly 24/7 AI assistant for the WebGuard monitoring product.
Tagline: Monitor. Protect. Assure.

- Creating monitors: HTTP / HTTPS websites only
- SEO Testing page (/app/seo): how to run scans and read scores
- Scans, schedules/intervals, alerts/email, reports/uptime, dashboard
- Signup/login, settings, dark mode, pricing, integrations

Rules:
- Answer the user's actual question accurately. Do not give login/password help unless they asked about signing in or passwords.
- Be concise (2–6 short sentences or a short numbered list).
- Do not invent fake account data or scan numbers.
- If unsure, say the exact clicks/path in the UI (e.g. Monitors → Create monitor → SEO Testing).
- WebGuard monitors HTTP/HTTPS websites only (not TCP, Ping, or DNS).
- Unrelated topics: politely steer back to WebGuard.`;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s./-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 1);
}

function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-word / phrase match — avoids "in" matching inside "testing". */
function hasPhrase(haystack, needle) {
  const h = normalizePhrase(haystack);
  const n = normalizePhrase(needle);
  if (!n) return false;
  if (n.includes(' ')) return h.includes(n);
  const re = new RegExp(`(?:^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
  return re.test(h);
}

function scoreEntry(message, entry) {
  const raw = String(message || '').toLowerCase();
  const tokens = new Set(tokenize(message));
  let score = 0;

  for (const phrase of entry.phrases || []) {
    if (hasPhrase(raw, phrase)) {
      const words = phrase.trim().split(/\s+/).length;
      score += 10 + words * 3;
    }
  }

  for (const kw of entry.keywords || []) {
    if (hasPhrase(raw, kw) || tokens.has(kw)) {
      score += kw.length >= 4 ? 4 : 2;
    }
  }

  if (entry.requireAny?.length) {
    const ok = entry.requireAny.some((r) => hasPhrase(raw, r) || tokens.has(normalizePhrase(r)));
    if (!ok) return 0;
  }

  // Boost clear intent words that should never lose to login/password
  if (/\bseo\b/i.test(raw) && entry.id === 'seo') score += 20;
  if (/\b(monitor|website|https?)\b/i.test(raw) && entry.id === 'monitors') score += 8;
  if (/\b(login|sign\s*in|password|forgot)\b/i.test(raw) && entry.id === 'login') score += 12;

  return score;
}

function localReply(message) {
  let best = null;
  let bestScore = 0;
  const scored = [];

  for (const entry of KNOWLEDGE) {
    const s = scoreEntry(message, entry);
    scored.push({ id: entry.id, s });
    if (s > bestScore) {
      bestScore = s;
      best = entry;
    }
  }

  // Need a real match — threshold avoids weak substring accidents
  if (best && bestScore >= 6) {
    return { reply: best.answer, source: 'knowledge', topic: best.id, score: bestScore };
  }

  return {
    reply:
      "I'm not sure I caught that. Tell me which page you're on (Dashboard / Monitors / SEO Testing / Scans / Alerts) and what you want to do.\nExamples: “How do I add a website?”, “How do I run a scan?”, “How do I check SEO?” or “Why is my monitor slow?”",
    source: 'fallback',
  };
}

async function openAiReply(message, history = []) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const kbHint = KNOWLEDGE.map((k) => `- ${k.id}: ${k.phrases.slice(0, 3).join(', ')}`).join('\n');

  const messages = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n\nKnown topics:\n${kbHint}`,
    },
    ...history.slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 2000),
    })),
    { role: 'user', content: String(message).slice(0, 2000) },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.35,
      max_tokens: 520,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn('[support] OpenAI error:', res.status, errText.slice(0, 200));
    return null;
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) return null;
  return { reply, source: 'openai' };
}

async function answerSupport(message, history = []) {
  const trimmed = String(message || '').trim();
  if (!trimmed) {
    return { reply: 'Send a short question and I’ll help.', source: 'validation' };
  }

  // Prefer accurate local KB for product how-tos (avoids wrong LLM guesses)
  const local = localReply(trimmed);
  if (local.source === 'knowledge' && local.score >= 10) {
    return local;
  }

  try {
    const ai = await openAiReply(trimmed, history);
    if (ai) return ai;
  } catch (err) {
    console.warn('[support] OpenAI failed:', err.message);
  }

  return local;
}

module.exports = { answerSupport, localReply };
