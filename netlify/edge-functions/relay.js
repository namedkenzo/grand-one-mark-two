/**
 * Grade One Mark Two – Secure Edge Relay with Static File Passthrough
 *
 * This Netlify Edge Function acts as a transparent reverse proxy.
 * It forwards non‑static requests to a configured upstream server,
 * sanitizes headers, and provides a health‑check endpoint.
 *
 * Environment Variables:
 *   TARGET_DOMAIN – Base URL of the upstream server (e.g., https://example.com:443)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Upstream target, read from environment variable and normalized. */
const UPSTREAM_BASE = (Netlify.env.get("TARGET_DOMAIN") ?? "").replace(/\/+$/, "");

/**
 * Headers that must be removed from client requests before forwarding.
 * These are either hop‑by‑hop headers or ones that the edge injects itself.
 */
const EXCLUDED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  // Netlify‑specific internal headers
  "x-nf-connection",
  "x-nf-request-id",
  "x-nf-debug",
  // Prevent header injection
  "x-forwarded-server",
  "x-real-ip",
]);

/**
 * Response headers that should never be forwarded back to the client.
 */
const EXCLUDED_RESPONSE_HEADERS = new Set([
  "transfer-encoding",   // handled by the runtime
  "content-encoding",    // let Netlify re‑compress if needed
  "set-cookie",          // security: do not leak upstream cookies by default
]);

// ---------------------------------------------------------------------------
// Static‑File Detection
// ---------------------------------------------------------------------------

/**
 * File extensions that are treated as static assets.
 * All requests for these are passed through to Netlify's CDN.
 */
const STATIC_EXTENSIONS = /\.(html|css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|json|map|webmanifest)(\?.*)?$/i;

/**
 * Paths that should be served as static files even without an extension.
 */
const STATIC_PATHS = new Set(["/", "/favicon.ico"]);

/**
 * Determine whether the given pathname corresponds to a static file.
 * @param {string} pathname
 * @returns {boolean}
 */
function isStaticRequest(pathname) {
  return STATIC_PATHS.has(pathname) || STATIC_EXTENSIONS.test(pathname);
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Copy and sanitise headers from the incoming request.
 * Returns a plain object suitable for fetch().
 */
function buildUpstreamHeaders(requestHeaders) {
  const headers = new Headers();

  for (const [key, value] of requestHeaders) {
    const lower = key.toLowerCase();

    // Skip excluded headers and any Netlify internal prefix
    if (EXCLUDED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-nf-") || lower.startsWith("x-netlify-")) continue;

    headers.set(key, value);
  }

  // Ensure the correct Host header is sent to the upstream
  const upstreamUrl = new URL(UPSTREAM_BASE);
  headers.set("host", upstreamUrl.host);

  return headers;
}

/**
 * Filter response headers before sending them back to the client.
 */
function filterResponseHeaders(upstreamHeaders) {
  const headers = new Headers();

  for (const [key, value] of upstreamHeaders) {
    const lower = key.toLowerCase();
    if (EXCLUDED_RESPONSE_HEADERS.has(lower)) continue;
    // Prevent leaking internal headers
    if (lower.startsWith("x-nf-") || lower.startsWith("x-netlify-")) continue;
    headers.set(key, value);
  }

  return headers;
}

/**
 * Return a standard error response.
 */
function errorResponse(message, status = 502) {
  return new Response(`GradeOneMarkTwo: ${message}`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

export default async function handler(request) {
  // 1. Validate configuration
  if (!UPSTREAM_BASE) {
    return errorResponse("TARGET_DOMAIN not configured", 500);
  }

  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;

  // 2. Health‑check endpoint
  if (pathname === "/status") {
    const payload = {
      status: "ok",
      upstream: UPSTREAM_BASE,
      timestamp: Date.now(),
    };
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // 3. Static‑file passthrough
  if (isStaticRequest(pathname)) {
    // Returning nothing lets Netlify serve the file from the `public` directory.
    return;
  }

  // 4. Relay to upstream
  try {
    const destination = `${UPSTREAM_BASE}${pathname}${requestUrl.search}`;
    const upstreamHeaders = buildUpstreamHeaders(request.headers);

    const fetchOptions = {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "manual",
      // Prevent streaming issues with GET/HEAD
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    };

    // Add a reasonable timeout to avoid hanging requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s
    fetchOptions.signal = controller.signal;

    const upstreamResponse = await fetch(destination, fetchOptions);
    clearTimeout(timeoutId);

    const respHeaders = filterResponseHeaders(upstreamResponse.headers);

    // Stream the body directly to avoid buffering
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: respHeaders,
    });

  } catch (error) {
    console.error("Relay error:", error);
    return errorResponse("Gateway Timeout");
  }
}
