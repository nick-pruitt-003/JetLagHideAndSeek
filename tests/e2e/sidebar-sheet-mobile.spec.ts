import { expect, test } from "@playwright/test";

// Phones get the sidebars as a non-modal bottom sheet so the map stays usable
// while questions are edited. Desktop keeps the docked sidebar.
test.skip(({ isMobile }) => !isMobile, "phone layout only");

test.beforeEach(async ({ page }) => {
    // The tutorial auto-opens on a first visit and would sit over everything.
    await page.addInitScript(() => {
        localStorage.setItem("showTutorials", "false");
    });
    await page.goto("./");
});

test("questions open as a bottom sheet with the map usable above it", async ({
    page,
}) => {
    await page
        .locator("[data-tutorial-id=left-sidebar-trigger] button")
        .click();

    const sheet = page.locator("[data-mobile=true]");
    await expect(sheet).toBeVisible();

    const viewport = page.viewportSize()!;
    // Poll: the sheet slides up for 500ms, so early frames sit partly
    // off-screen. Wait until its bottom edge reaches the viewport's.
    await expect
        .poll(async () => {
            const b = await sheet.boundingBox();
            return b ? b.y + b.height : Infinity;
        })
        .toBeLessThanOrEqual(viewport.height + 1);
    const box = (await sheet.boundingBox())!;
    expect(box.y).toBeGreaterThan(viewport.height * 0.3);

    // Above the sheet is map, not a dimming overlay.
    const aboveSheet = { x: viewport.width / 2, y: box.y / 2 };
    const hitsMap = await page.evaluate(
        ({ x, y }) =>
            !!document.elementFromPoint(x, y)?.closest(".leaflet-container"),
        aboveSheet,
    );
    expect(hitsMap).toBe(true);

    // Panning the map must not dismiss the sheet.
    await page.mouse.move(aboveSheet.x, aboveSheet.y);
    await page.mouse.down();
    await page.mouse.move(aboveSheet.x + 60, aboveSheet.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect(sheet).toBeVisible();

    // The handle grows the sheet for long forms.
    await page.getByRole("button", { name: "Expand panel" }).click();
    await expect
        .poll(async () => (await sheet.boundingBox())?.height ?? 0)
        .toBeGreaterThan(box.height + 50);

    await page.getByRole("button", { name: "Close questions" }).click();
    await expect(sheet).toBeHidden();
});

test("typing a number gets the number pad and hides the footer", async ({
    page,
}) => {
    await page
        .locator("[data-tutorial-id=left-sidebar-trigger] button")
        .click();
    await page.getByRole("button", { name: "Add Question" }).click();
    await page.getByRole("dialog").getByText("Add Radius").click();

    const radius = page
        .locator("[data-mobile=true] input[type=number]")
        .first();
    await expect(radius).toHaveAttribute("inputmode", "decimal");

    // While typing, the fixed footer steps aside so the keyboard doesn't
    // squeeze the question to a sliver.
    const footerButton = page
        .locator("[data-mobile=true]")
        .getByRole("button", { name: "Open Hiding Zones" });
    await expect(footerButton).toBeVisible();
    await radius.focus();
    await expect(footerButton).toBeHidden();
    await radius.blur();
    await expect(footerButton).toBeVisible();
});
