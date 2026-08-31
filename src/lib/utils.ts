import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import {
    PASTEBIN_API_POST_URL,
    PASTEBIN_API_RAW_URL,
    PASTEBIN_API_RAW_URL_PROXIED,
} from "@/maps/api/constants";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export const mapToObj = <T, K extends string, V>(
    arr: T[],
    fn: (item: T) => [K, V],
) => Object.fromEntries(arr.map(fn));

export const compress = async (
    str: string,
    encoding = "deflate" as CompressionFormat,
): Promise<string> => {
    const byteArray = new TextEncoder().encode(str);
    const cs = new CompressionStream(encoding);
    const writer = cs.writable.getWriter();
    writer.write(byteArray);
    writer.close();
    const arrayBuffer = await new Response(cs.readable).arrayBuffer();

    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
};

export const decompress = async (
    base64String: string,
    encoding = "deflate" as CompressionFormat,
): Promise<string> => {
    const regularBase64 = base64String.replace(/-/g, "+").replace(/_/g, "/");
    const paddedBase64 =
        regularBase64 + "=".repeat((4 - (regularBase64.length % 4)) % 4);

    const binaryString = atob(paddedBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    const cs = new DecompressionStream(encoding);
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const arrayBuffer = await new Response(cs.readable).arrayBuffer();
    return new TextDecoder().decode(arrayBuffer);
};

export async function uploadToPastebin(
    apiKey: string,
    data: string,
): Promise<string> {
    const formData = new FormData();
    formData.append("api_option", "paste");
    formData.append("api_dev_key", apiKey);
    formData.append("api_paste_code", data);
    formData.append("api_paste_private", "1"); // 1 for unlisted
    formData.append("api_paste_expire_date", "N"); // N for never

    const response = await fetch(PASTEBIN_API_POST_URL, {
        method: "POST",
        body: formData,
    });

    const responseText = await response.text();
    if (!response.ok || responseText.startsWith("Bad API request,")) {
        throw new Error("Pastebin API error: " + responseText);
    }

    return responseText;
}

export async function fetchFromPastebin(pasteId: string): Promise<string> {
    let response;
    try {
        // prefer querying Pastebin directly since CORS proxy is unreliable
        response = await fetch(PASTEBIN_API_RAW_URL + pasteId);
    } catch {
        // CORS error; happens if the paste is not owned by a Pastebin Pro user
        response = await fetch(PASTEBIN_API_RAW_URL_PROXIED + pasteId);
    }

    if (!response.ok) {
        throw new Error(
            "Failed to fetch from Pastebin: " + response.statusText,
        );
    }

    return response.text();
}

/**
 * Open native share sheet or fallback to sending to clipboard
 * @param url URL to share
 * @param forceClipboard Whether to force usage of the clipboard (instead of share sheet)
 * @returns `true` for native success, `"clipboard"` for clipboard success,
 * `"cancelled"` when the user dismissed the share sheet, and `false` when both
 * native sharing and the clipboard fallback actually failed
 */
export async function shareOrFallback(
    url: string,
    forceClipboard = false,
): Promise<boolean | "clipboard" | "cancelled"> {
    if (forceClipboard) {
        if (!navigator || !navigator.clipboard) {
            // Clipboard not supported
            return false;
        }

        // Previously this fire-and-forgot writeText and returned "clipboard"
        // unconditionally — meaning a denied permission or insecure context
        // would report success. Await and return `false` on failure so the
        // caller can surface a real error instead of a false-positive.
        try {
            await navigator.clipboard.writeText(url);
            return "clipboard";
        } catch {
            // Chromium rejects clipboard writes while the document is
            // unfocused, which is exactly the state right after a share sheet
            // closes. Wait briefly for focus to come back and retry once.
            const refocused = await waitForFocus(1000);
            if (!refocused) return false;

            try {
                await navigator.clipboard.writeText(url);
                return "clipboard";
            } catch {
                return false;
            }
        }
    }

    if (!navigator.share) return shareOrFallback(url, true); // Fallback to clipboard

    try {
        await navigator.share({ url });
        return true;
    } catch (error) {
        // Dismissing the share sheet rejects with AbortError. That is not a
        // failure — falling through to the clipboard here produced a scary
        // "Clipboard not supported, copy this manually" toast every time
        // someone changed their mind about sharing.
        if (error instanceof DOMException && error.name === "AbortError") {
            return "cancelled";
        }

        // Try again with clipboard
        return shareOrFallback(url, true);
    }
}

/** Resolve once the document regains focus, or `false` if it never does. */
function waitForFocus(timeoutMs: number): Promise<boolean> {
    if (typeof document === "undefined") return Promise.resolve(false);
    if (document.hasFocus()) return Promise.resolve(true);

    return new Promise((resolve) => {
        const done = (value: boolean) => {
            window.removeEventListener("focus", onFocus);
            clearTimeout(timer);
            resolve(value);
        };
        const onFocus = () => done(true);
        const timer = setTimeout(() => done(false), timeoutMs);
        window.addEventListener("focus", onFocus);
    });
}
