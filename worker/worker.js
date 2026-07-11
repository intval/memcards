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
 *   ALLOWED_HOSTS  comma-separated hostname allowlist. If unset/empty, ANY host
 *                  is allowed (open proxy — fine for personal use; set this to
 *                  lock it down before exposing it publicly).
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
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
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return err(405, "method not allowed");
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) return err(400, "missing ?url=");

    let dest;
    try {
      dest = new URL(target);
    } catch {
      return err(400, "invalid url");
    }
    if (dest.protocol !== "http:" && dest.protocol !== "https:") {
      return err(400, "only http/https allowed");
    }
    if (!hostAllowed(dest.hostname, env)) {
      return err(403, `host not allowed: ${dest.hostname}`);
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
      return err(502, "upstream fetch failed: " + String(e));
    }

    // Pass the body through, preserving content-type, adding CORS.
    const headers = new Headers(CORS);
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

function err(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
