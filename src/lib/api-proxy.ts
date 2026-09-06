/**
 * Shared request-validation plumbing for the two server-side proxies
 * (`/api/proxy-api` and `/api/proxy-gtfs`).
 *
 * Only the parts that are genuinely identical live here. The allow-list
 * *policy* deliberately does not: proxy-api matches hostnames exactly (no
 * subdomain of a proxied host is ever legitimate, and accepting one would
 * widen the SSRF surface), while proxy-gtfs accepts subdomains because
 * agencies move feeds between them. Each route passes its own predicate.
 */

/** JSON error body with the CORS header both proxies always send. */
export function jsonError(
    status: number,
    message: string,
    extraHeaders?: Record<string, string>,
): Response {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        ...extraHeaders,
    };
    // Let the browser read retry-after cross-origin when we forward it.
    if (extraHeaders?.["retry-after"]) {
        headers["access-control-expose-headers"] = "retry-after";
    }
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers,
    });
}

/**
 * Parse and vet the `?url=` parameter both proxies take: present, parseable,
 * on the caller's allow-list, and http(s). Returns the target URL or the
 * error response to send back verbatim.
 */
export function resolveProxyTarget(
    url: URL,
    isAllowedHost: (hostname: string) => boolean,
    denyHint = "",
): { ok: true; target: URL } | { ok: false; response: Response } {
    const target = url.searchParams.get("url");
    if (!target) {
        return {
            ok: false,
            response: jsonError(400, "Missing `url` query parameter."),
        };
    }

    let targetUrl: URL;
    try {
        targetUrl = new URL(target);
    } catch {
        return {
            ok: false,
            response: jsonError(400, "Malformed `url` parameter."),
        };
    }

    if (!isAllowedHost(targetUrl.hostname)) {
        return {
            ok: false,
            response: jsonError(
                403,
                `Host not on allow-list: ${targetUrl.hostname}${denyHint}`,
            ),
        };
    }

    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        return {
            ok: false,
            response: jsonError(
                400,
                `Unsupported protocol: ${targetUrl.protocol}`,
            ),
        };
    }

    return { ok: true, target: targetUrl };
}
