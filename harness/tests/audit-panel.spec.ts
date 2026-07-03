import { test, expect } from "@playwright/test";

test("Audit panel: runs core checks and renders results", async ({ page }) => {
    await page.addInitScript(() => {
        const controlId = "PcfWorkbench.ConformanceTester";
        localStorage.setItem(
            `pcf-workbench-scenarios-${controlId}`,
            JSON.stringify([{ schemaVersion: 2, name: "Default", savedAt: new Date().toISOString() }]),
        );
        localStorage.setItem(`pcf-workbench-active-scenario-${controlId}`, "Default");
        localStorage.setItem("pcf-workbench-suppress-autogen-all", "1");
    });

    await page.goto("/");
    await page.waitForLoadState("load");

    await page.getByRole("tab", { name: "Audit" }).click();
    const panel = page.locator('[data-test-id="audit-panel"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    await expect(panel.getByText("Accessibility audit (axe-core)")).toBeVisible();
    await expect(panel.getByText("Manifest version bump")).toBeVisible();
    await expect(panel.getByText("Bundle size budget")).toBeVisible();

    const rows = panel.locator("div").filter({ hasText: /^.*(PASS|WARN|ERROR|IGNORED).*$/ });
    await expect(rows.first()).toBeVisible();
});
