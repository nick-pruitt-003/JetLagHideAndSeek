// Client-side service-worker registration with an update-available
// toast. Called once from `Layout.astro`. Safe no-op in SSR and in
// browsers without SW support.
//
// Design notes:
//   * The SW source is `src/sw.ts` and the bundled output is emitted
//     to `dist/client/sw.js` by the hand-rolled `serwistIntegration`
//     in `astro.config.mjs` (esbuild bundle + @serwist/build
//     injectManifest, in the `astro:build:done` hook). In production
//     it's a plain static asset at `<base>sw.js`. During `astro dev`
//     the integration is disabled by default — set `PUBLIC_ENABLE_SW=1`
//     to opt back in when testing offline behavior locally.
//   * Registration is scoped to `import.meta.env.BASE_URL`, which is
//     `/JetLagHideAndSeek/` on GH Pages and `/` on Railway. Matching
//     the scope to the base means the SW only controls URLs under the
//     app, which is both correct and avoids stomping on other apps
//     sharing the GH Pages domain.
//   * The update flow is user-driven: when a new SW is waiting, we
//     show a sticky toast with a "Reload" action. Clicking it posts
//     `SKIP_WAITING` to the waiting SW, which activates it and fires
//     `controllerchange`; we then `location.reload()` so the user
//     sees the new assets. This matches `src/sw.ts` where
//     `skipWaiting: false` is set — the new SW waits for our explicit
//     signal instead of activating while a game is in progress.

import { Serwist } from "@serwist/window";
import { toast } from "react-toastify";

const TOAST_ID = "sw-update-available";

export function registerServiceWorker() {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // `import.meta.env.BASE_URL` is injected by Vite with a trailing
    // slash — e.g. "/JetLagHideAndSeek/" or "/". We want the SW
    // script URL to be `<base>sw.js` and the registration scope to
    // be `<base>`.
    const base = import.meta.env.BASE_URL;
    const scriptURL = `${base}sw.js`;
    const scope = base;

    // `type: "module"` matches the esbuild `format: "esm"` we use in
    // the custom Astro integration — our sw.ts uses ES imports at the
    // top level, which require an ES-module service worker on the
    // browser side.
    const sw = new Serwist(scriptURL, { scope, type: "module" });

    let reloadingForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadingForUpdate) return;
        reloadingForUpdate = true;
        // New SW took control — reload so the freshly-precached
        // assets are picked up on the next navigation.
        window.location.reload();
    });

    sw.addEventListener("waiting", () => {
        // Sticky toast with a manual Reload button. `autoClose: false`
        // so users in the middle of a game don't lose it.
        toast.info("A new version of the app is ready.", {
            toastId: TOAST_ID,
            autoClose: false,
            closeOnClick: false,
            draggable: false,
            onClick: () => {
                reloadingForUpdate = true;
                sw.messageSkipWaiting();
            },
            // Using data to hint the user that the entire toast is
            // clickable. Styling nudges for this live alongside the
            // rest of the toastify overrides in globals.css.
        });
    });

    sw.register().catch((err: unknown) => {
        // We deliberately don't toast on registration failure — it
        // happens routinely in unsupported contexts (iOS private
        // browsing, some embedded webviews) and surfacing it would
        // be noise. Log for developer debugging.
        console.log("Service worker registration failed:", err);
    });
}
