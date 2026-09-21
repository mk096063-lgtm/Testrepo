// CNCVEYRA — single Cloudflare Worker.
//
// This one Worker does two jobs on the same domain (so there is no CORS,
// and no separate URL to keep in sync with the frontend):
//   1. Serves the static site (index.html, cncveyralive.html, etc.) via
//      the "ASSETS" binding — configured in wrangler.toml.
//   2. Handles the /api/* routes with the real G-code generation logic,
//      which lives only in src/logic.js and never ships to the browser.
//
// Both API routes are protected by:
//   - an Origin/Referer allow-list (only cncveyra.in may call them), and
//   - a simple per-IP rate limit backed by the RATE_LIMIT KV namespace.

import { generateTurningCode, generateThreadCode } from './logic.js';

const ALLOWED_ORIGINS = [
  'https://cncveyra.in',
  'https://www.cncveyra.in',
];

// How many requests a single IP may make to an /api/* route per window.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Accepts the request only if it says it came from our own site. Origin is
// sent on same-site fetch()/POST calls; Referer is used as a fallback for
// browsers/setups that omit Origin. Anything else (direct curl/Postman
// hits, other sites trying to call the API) is rejected.
function isAllowedOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) return true;

  const referer = request.headers.get('Referer') || '';
  return ALLOWED_ORIGINS.some((o) => referer.startsWith(o));
}

// Very small fixed-window counter stored in KV, keyed by client IP + route.
// Not perfectly race-proof (KV is eventually consistent), but it is enough
// to stop casual scripted abuse without adding a database.
async function checkRateLimit(env, request, routeName) {
  if (!env.RATE_LIMIT) return true; // fail-open if KV isn't bound yet
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${routeName}:${ip}`;

  const current = await env.RATE_LIMIT.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= RATE_LIMIT_MAX) return false;

  await env.RATE_LIMIT.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
  return true;
}

async function guardedApiHandler(request, env, routeName, logicFn) {
  if (request.method === 'OPTIONS') {
    // Same-origin only — no cross-site calls need to be allowed, but an
    // OPTIONS pre-flight is answered harmlessly just in case.
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }
  if (!isAllowedOrigin(request)) {
    return json(403, { ok: false, error: 'Forbidden' });
  }
  const allowed = await checkRateLimit(env, request, routeName);
  if (!allowed) {
    return json(429, { ok: false, error: 'Too many requests. Please wait a moment and try again.' });
  }

  try {
    const body = await request.json();
    const result = logicFn(body || {});
    return json(200, { ok: true, ...result });
  } catch (e) {
    return json(400, { ok: false, error: (e && e.message) || 'Generation failed.' });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/generate-turning') {
      return guardedApiHandler(request, env, 'turning', generateTurningCode);
    }
    if (url.pathname === '/api/generate-thread') {
      return guardedApiHandler(request, env, 'thread', generateThreadCode);
    }

    // Everything else (index.html, cncveyralive.html, images, etc.) is
    // served straight from the public/ folder via the assets binding.
    return env.ASSETS.fetch(request);
  },
};
