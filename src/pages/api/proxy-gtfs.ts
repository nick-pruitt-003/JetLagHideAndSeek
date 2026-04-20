/**
 * Self-hosted CORS proxy for GTFS feeds. Inert on static builds; activates
 * when the app is deployed with an SSR adapter (Railway, Vercel, etc).
 *
 * The client sends `GET /api/proxy-gtfs?url=<encoded-gtfs-zip-url>`; we
 * stream the upstream response back verbatim with an
 * `Access-Control-Allow-Origin: *` header.
 *
 * Safety:
 *   - Only allow-listed hosts are proxied (see ALLOWED_HOSTS). We don't want
 *     to be a free open proxy for the internet — both for abuse reasons and
 *     to keep bandwidth costs predictable.
 *   - The request is capped at 200 MB. NYC Subway's zip is ~10 MB, NJT's
 *     is ~80 MB, so 200 MB leaves headroom without being a DoS vector.
 */

import type { APIRoute } from "astro";

export const prerender = false;

/**
 * Hosts we'll proxy to. Case-insensitive suffix match. Add new agencies as
 * presets are added in `presets.ts`.
 */
const ALLOWED_HOSTS = [
    // MTA
    "api.mta.info",
    "rrgtfsfeeds.s3.amazonaws.com",
    "mta.info",
    // NJ Transit
    "www.njtransit.com",
    "njtransit.com",
    "data.trilliumtransit.com",
    // CTrail (Shore Line East)
    "www.cttransit.com",
    "cttransit.com",
    // MobilityData catalog (common mirror)
    "storage.googleapis.com",
    "gtfs.transitfeeds.com",
    // Generic hobby mirrors
    "transitfeeds.com",
];

const MAX_BYTES = 200 * 1024 * 1024;

export const GET: APIRoute = async ({ url }) => {
    const target = url.searchParams.get("url");
    if (!target) {
        return jsonError(400, "Missing `url` query parameter.");
    }

    let targetUrl: URL;
    try {
        targetUrl = new URL(target);
    } catch {
        return jsonError(400, "Malformed `url` parameter.");
    }

    if (!isAllowedHost(targetUrl.hostname)) {
        return jsonError(
            403,
            `Host not on allow-list: ${targetUrl.hostname}. ` +
                `Edit src/pages/api/proxy-gtfs.ts ALLOWED_HOSTS to add it.`,
        );
    }

    // Only allow http(s).
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        return jsonError(400, `Unsupported protocol: ${targetUrl.protocol}`);
    }

    let upstream: Response;
    try {
        upstream = await fetch(targetUrl.toString(), {
            redirect: "follow",
            // Identify ourselves so agencies can spot us in their logs.
            headers: { "user-agent": "JetLagHideAndSeek-GTFS-Proxy/1.0" },
        });
    } catch (err) {
        return jsonError(
            502,
            `Upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!upstream.ok) {
        return jsonError(
            upstream.status,
            `Upstream returned HTTP ${upstream.status}: ${upstream.statusText}`,
        );
    }

    // Enforce size cap via Content-Length if upstream declares one.
    const declaredLength = upstream.headers.get("content-length");
    if (declaredLength && parseInt(declaredLength, 10) > MAX_BYTES) {
        return jsonError(
            413,
            `Upstream response is ${declaredLength} bytes, cap is ${MAX_BYTES}.`,
        );
    }

    // Stream through, counting bytes and aborting if we exceed the cap mid-
    // stream. This protects against servers that lie about Content-Length.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    (async () => {
        if (!upstream.body) {
            await writer.close();
            return;
        }
        const reader = upstream.body.getReader();
        let bytes = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    bytes += value.byteLength;
                    if (bytes > MAX_BYTES) {
                        await writer.abort(
                            new Error("Response exceeded maximum size"),
                        );
                        return;
                    }
                    await writer.write(value);
                }
            }
            await writer.close();
        } catch (err) {
            await writer.abort(err);
        }
    })();

    const headers = new Headers({
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "content-length, content-type",
        "content-type":
            upstream.headers.get("content-type") ?? "application/zip",
        "cache-control": "private, max-age=0, no-cache",
    });
    // Forward Content-Length when present so the client can show a progress
    // bar. Our mid-stream size check still protects against mis-declaration.
    const len = upstream.headers.get("content-length");
    if (len) headers.set("content-length", len);

    return new Response(readable, { status: 200, headers });
};

function isAllowedHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return ALLOWED_HOSTS.some(
        (host) => lower === host || lower.endsWith(`.${host}`),
    );
}

function jsonError(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
    });
}
