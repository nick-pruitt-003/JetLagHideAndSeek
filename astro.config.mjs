// @ts-check
import node from "@astrojs/node";
import partytown from "@astrojs/partytown";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// Railway sets RAILWAY_PUBLIC_DOMAIN automatically on deploy. Use it to
// auto-pick sensible defaults so no env vars need to be configured by hand.
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const isRailway = !!railwayDomain || !!process.env.RAILWAY_ENVIRONMENT;

// Base path: GH Pages needs "/JetLagHideAndSeek", Railway serves at root.
// Astro 6 requires a leading slash. Override with PUBLIC_BASE_PATH at build time.
const base =
    process.env.PUBLIC_BASE_PATH ?? (isRailway ? "/" : "/JetLagHideAndSeek");

// Site URL: used for absolute links, sitemap, manifest, etc.
const site =
    process.env.PUBLIC_SITE_URL ??
    (railwayDomain
        ? `https://${railwayDomain}`
        : "https://taibeled.github.io");

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
