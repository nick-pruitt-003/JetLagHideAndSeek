import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4321/JetLagHideAndSeek";

export default defineConfig({
    testDir: "./tests/e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? "github" : "list",
    use: {
        baseURL,
        trace: "on-first-retry",
    },
    webServer: {
        command: "pnpm dev --host 127.0.0.1",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "mobile-chromium",
            use: { ...devices["Pixel 5"] },
        },
    ],
});
