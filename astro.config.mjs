// @ts-check
import node from "@astrojs/node";
import partytown from "@astrojs/partytown";
import react from "@astrojs/react";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";

// Base path: GH Pages needs "/JetLagHideAndSeek", Railway serves at root.
// Override with PUBLIC_BASE_PATH at build time.
const base = process.env.PUBLIC_BASE_PATH ?? "JetLagHideAndSeek";

// Site URL: used for absolute links, sitemap, etc. Override per deployment.
const site = process.env.PUBLIC_SITE_URL ?? "https://taibeled.github.io";

// https://astro.build/config
export default defineConfig({
    integrations: [
        react(),
        partytown({
            config: {
                forward: ["dataLayer.push"],
            },
        }),
        AstroPWA({
            manifest: {
                name: "Jet Lag Hide and Seek Map Generator",
                short_name: "Map Generator",
                description:
                    "Automatically generate maps for Jet Lag The Game: Hide and Seek with ease! Simply name the questions and watch the map eliminate hundreds of possibilities in seconds.",
                icons: [
                    {
                        src: "https://taibeled.github.io/JetLagHideAndSeek/JLIcon.png",
                        sizes: "1080x1080",
                        type: "image/png",
                    },
                    {
                        src: "https://taibeled.github.io/JetLagHideAndSeek/android-chrome-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                    },
                    {
                        src: "https://taibeled.github.io/JetLagHideAndSeek/android-chrome-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                    },
                ],
                theme_color: "#1F2F3F",
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
