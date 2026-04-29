// Grade One Mark Two – Secure Edge Relay with Static File Passthrough
const UPSTREAM_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");

const EXCLUDED_HEADERS = new Set([
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
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
]);

// لیست پسوندها و مسیرهایی که از رله خارج شوند و به‌عنوان فایل استاتیک سرو شوند
const STATIC_EXTENSIONS = /\.(html|css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|json|map|webmanifest)$/i;
const STATIC_PATHS = ["/", "/favicon.ico"]; // مسیرهایی که بدون پسوند هم استاتیک هستند

function isStaticRequest(pathname) {
    if (STATIC_PATHS.includes(pathname)) return true;
    return STATIC_EXTENSIONS.test(pathname);
}

export default async function handler(request) {
    // اگر TARGET_DOMAIN تنظیم نشده باشد
    if (!UPSTREAM_BASE) {
        return new Response("GradeOneMarkTwo Error: TARGET_DOMAIN not configured", {
            status: 500,
        });
    }

    const reqUrl = new URL(request.url);
    const pathname = reqUrl.pathname;

    // --- ENDPOINT مخصوص STATUS ---
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

    // --- PASS-THROUGH برای فایل‌های استاتیک (index.html و غیره) ---
    if (isStaticRequest(pathname)) {
        // خروج بدون return، تا Netlify فایل را از public سرو کند
        return;
    }

    // --- RELAY برای تمام مسیرهای دیگر ---
    try {
        const destination = UPSTREAM_BASE + pathname + reqUrl.search;
        const outHeaders = new Headers();
        let clientIp = null;

        for (const [key, value] of request.headers) {
            const k = key.toLowerCase();

            if (EXCLUDED_HEADERS.has(k)) continue;
            if (k.startsWith("x-nf-")) continue;
            if (k.startsWith("x-netlify-")) continue;

            if (k === "x-real-ip") {
                clientIp = value;
                continue;
            }
            if (k === "x-forwarded-for") {
                if (!clientIp) clientIp = value;
                continue;
            }

            outHeaders.set(key, value);
        }

        if (clientIp) outHeaders.set("x-forwarded-for", clientIp);

        const fetchOptions = {
            method: request.method,
            headers: outHeaders,
            redirect: "manual",
        };

        const hasPayload = request.method !== "GET" && request.method !== "HEAD";
        if (hasPayload) fetchOptions.body = request.body;

        const upstreamResp = await fetch(destination, fetchOptions);

        const respHeaders = new Headers();
        for (const [key, value] of upstreamResp.headers) {
            if (key.toLowerCase() === "transfer-encoding") continue;
            respHeaders.set(key, value);
        }

        return new Response(upstreamResp.body, {
            status: upstreamResp.status,
            headers: respHeaders,
        });
    } catch (e) {
        return new Response("GradeOneMarkTwo: Gateway Timeout", { status: 502 });
    }
}
