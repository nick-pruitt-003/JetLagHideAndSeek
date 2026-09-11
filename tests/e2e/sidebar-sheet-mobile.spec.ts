import { expect, type Locator, test } from "@playwright/test";

// Phones get the sidebars as a non-modal bottom sheet so the map stays usable
// while questions are edited. Desktop keeps the docked sidebar.
test.skip(({ isMobile }) => !isMobile, "phone layout only");

/** Wait out the slide-in (or resize) so measurements see the final layout. */
const settled = (locator: Locator) =>
    locator.evaluate((element) =>
        Promise.all(
            element
                .getAnimations({ subtree: false })
                .map((animation) => animation.finished),
        ),
    );

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
    await settled(sheet);
    // Focus lands in the sheet, not in a field that would raise the keyboard.
    await expect(sheet).toBeFocused();
    const box = (await sheet.boundingBox())!;
    expect(box.y).toBeGreaterThan(viewport.height * 0.3);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

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
    // Poll rather than settled(): the height transition may not have started
    // by the time the click returns.
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

test.describe("held sideways", () => {
    // Pixel 5 rotated. Wider than the 768px breakpoint, so this only counts as
    // mobile through the short-touch-screen rule in useIsMobile.
    test.use({ viewport: { width: 851, height: 393 } });

    test("questions open as a half-width side panel beside the map", async ({
        page,
    }) => {
        await page
            .locator("[data-tutorial-id=left-sidebar-trigger] button")
            .click();

        // data-mobile is only set on the phone sheet, never on the docked
        // desktop sidebar, so seeing it proves the mobile classification.
        const sheet = page.locator("[data-mobile=true]");
        await expect(sheet).toBeVisible();

        const viewport = page.viewportSize()!;
        await settled(sheet);
        const box = (await sheet.boundingBox())!;
        expect(box.height).toBeGreaterThan(viewport.height - 2);
        expect(box.width).toBeLessThan(viewport.width * 0.6);
        // Half of a 393px height would leave no room, so no resize handle.
        await expect(
            page.getByRole("button", { name: "Expand panel" }),
        ).toBeHidden();

        const besideSheet = {
            x: (box.x + box.width + viewport.width) / 2,
            y: viewport.height / 2,
        };
        const hitsMap = await page.evaluate(
            ({ x, y }) =>
                !!document
                    .elementFromPoint(x, y)
                    ?.closest(".leaflet-container"),
            besideSheet,
        );
        expect(hitsMap).toBe(true);

        await page.mouse.move(besideSheet.x, besideSheet.y);
        await page.mouse.down();
        await page.mouse.move(besideSheet.x + 60, besideSheet.y + 20, {
            steps: 5,
        });
        await page.mouse.up();
        await expect(sheet).toBeVisible();

        await page.getByRole("button", { name: "Close questions" }).click();
        await expect(sheet).toBeHidden();
    });
});
