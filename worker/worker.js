/**
 * Generic CORS proxy (Cloudflare Worker).
 *
 * Fetches any URL server-side and returns the response with permissive CORS
 * headers, so a static browser SPA can read cross-origin pages/APIs that would
 * otherwise be blocked. It is intentionally NOT tied to any one backend — the
 * app decides which URLs to fetch and how to parse them, so you can switch from
 * dict.cc to another dictionary/API without touching the Worker.
 *
 * Usage:  GET /?url=<absolute http(s) URL, percent-encoded>
 *   e.g.  /?url=https%3A%2F%2Fdeen.dict.cc%2F%3Fs%3DHund
 *
 * Config (optional, via wrangler vars):
 *   ALLOWED_HOSTS    comma-separated hostname allowlist. If unset/empty, ANY host
 *                    is allowed (open proxy — fine for personal use; set this to
 *                    lock it down before exposing it publicly).
 *   ALLOWED_ORIGINS  comma-separated browser origin allowlist (exact match). If
 *                    unset/empty, any origin is allowed (CORS "*"). Requests
 *                    carrying a disallowed Origin header get a 403.
 *
 * Bindings:
 *   RATE_LIMITER     Cloudflare rate-limit binding (per-IP). See wrangler.toml.
 */

const BASE_CORS = {
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// A browser-like UA — many sites (dict.cc included) reject bare/botty clients.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    // Reject browser calls from origins not on the allowlist. A request with no
    // Origin header (e.g. curl) has nothing to reflect and is left to the host
    // allowlist + rate limiter; it simply won't get CORS access.
    if (origin && !originAllowed(origin, env)) {
      return err(403, "origin not allowed", cors);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return err(405, "method not allowed", cors);
    }

    // Per-IP rate limit (10 req / 60s, configured in wrangler.toml).
    if (env && env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return err(429, "rate limited — slow down", cors);
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) return err(400, "missing ?url=", cors);

    let dest;
    try {
      dest = new URL(target);
    } catch {
      return err(400, "invalid url", cors);
    }
    if (dest.protocol !== "http:" && dest.protocol !== "https:") {
      return err(400, "only http/https allowed", cors);
    }
    if (!hostAllowed(dest.hostname, env)) {
      return err(403, `host not allowed: ${dest.hostname}`, cors);
    }

    let upstream;
    try {
      upstream = await fetch(dest.toString(), {
        method: request.method,
        headers: {
          "User-Agent": UA,
          "Accept-Language": request.headers.get("Accept-Language") || "en,de",
          Accept: request.headers.get("Accept") || "*/*",
        },
        redirect: "follow",
      });
    } catch (e) {
      return err(502, "upstream fetch failed: " + String(e), cors);
    }

    // Pass the body through, preserving content-type, adding CORS.
    const headers = new Headers(cors);
    const ct = upstream.headers.get("Content-Type");
    if (ct) headers.set("Content-Type", ct);
    headers.set("X-Proxied-From", dest.origin);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};

function hostAllowed(hostname, env) {
  const raw = (env && env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS : "").trim();
  if (!raw) return true; // no allowlist configured -> allow all
  const list = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  return list.some((h) => host === h || host.endsWith("." + h));
}

function originList(env) {
  const raw = (env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS : "").trim();
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

function originAllowed(origin, env) {
  const list = originList(env);
  if (!list.length) return true; // no allowlist configured -> allow all
  return list.includes(origin);
}

// Build CORS headers, reflecting the caller's origin only if it's allowed.
// With no allowlist configured we fall back to the permissive "*".
function corsHeaders(origin, env) {
  const headers = { ...BASE_CORS };
  const list = originList(env);
  if (!list.length) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && list.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function err(status, message, cors) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(cors || {}) },
  });
}
