// @ts-check
import node from "@astrojs/node";
import partytown from "@astrojs/partytown";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// Defensive env var cleanup — Railway's UI occasionally sneaks an extra `=`
// into values (e.g. KEY==value), and users often forget the scheme on URLs.
// Strip blanks and leading `=` from anything we touch here.
const cleanEnv = (v) => {
    if (v == null) return undefined;
    const trimmed = String(v).trim().replace(/^=+/, "").trim();
    return trimmed.length ? trimmed : undefined;
};

// Railway sets RAILWAY_PUBLIC_DOMAIN automatically on deploy. Use it to
// auto-pick sensible defaults so no env vars need to be configured by hand.
const railwayDomain = cleanEnv(process.env.RAILWAY_PUBLIC_DOMAIN);
const isRailway = !!railwayDomain || !!cleanEnv(process.env.RAILWAY_ENVIRONMENT);

// Base path: GH Pages needs "/JetLagHideAndSeek", Railway serves at root.
// Astro 6 requires a leading slash, so force one on whatever the user gave us.
let base = cleanEnv(process.env.PUBLIC_BASE_PATH) ?? (isRailway ? "/" : "/JetLagHideAndSeek");
if (!base.startsWith("/")) base = `/${base}`;

// Site URL: used for absolute links, sitemap, manifest, etc. Astro validates
// this with `new URL()`, so a bare domain like "foo.railway.app" would throw
// "Invalid URL". Auto-prepend https:// if the user forgot the scheme.
let site =
    cleanEnv(process.env.PUBLIC_SITE_URL) ??
    (railwayDomain
        ? `https://${railwayDomain}`
        : "https://taibeled.github.io");
if (!/^https?:\/\//i.test(site)) site = `https://${site}`;

// https://astro.build/config
export default defineConfig({
    integrations: [
        react(),
        partytown({
            config: {
                forward: ["dataLayer.push"],
            },
        }),
    ],
    devToolbar: {
        enabled: false,
    },
    site,
    base,
    // Astro 6: output defaults to "static". Pages are prerendered at build
    // time; API routes with `export const prerender = false` run on the
    // server via the configured adapter. On GH Pages (no adapter running),
    // those routes simply won't exist and the client falls back to the
    // public CORS proxy. On Railway the node adapter serves them.
    adapter: node({
        mode: "standalone",
    }),
});
