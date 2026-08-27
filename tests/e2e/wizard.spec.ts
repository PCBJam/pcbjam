// wxWizard Tests - Footprint Wizard simulation
import { test, expect, waitForWxApp } from './utils/fixtures';
import { clickByLabel, waitForElement, stableShot } from './utils/element-tracker';

test.describe('wxWizard Tests', () => {

  test('Wizard test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/wizard/wizard_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'wizard-01-loaded.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Wizard dialog can be launched', async ({ page }) => {
    await page.goto('/standalone/wizard/wizard_test.html');
    await waitForWxApp(page);

    // Click Launch button using element registry
    await waitForElement(page, 'Launch Footprint Wizard');
    const clicked = await clickByLabel(page, 'Launch Footprint Wizard');
    expect(clicked, 'Launch Wizard button should be found and clicked').toBe(true);

    await stableShot(page, 'wizard-02-launch.png', { fullPage: true });
  });

  test('Wizard can navigate to next page', async ({ page }) => {
    await page.goto('/standalone/wizard/wizard_test.html');
    await waitForWxApp(page);

    // Launch wizard using element registry
    await waitForElement(page, 'Launch Footprint Wizard');
    const launchClicked = await clickByLabel(page, 'Launch Footprint Wizard');
    expect(launchClicked, 'Launch Wizard button should be found').toBe(true);

    // Click Next using element registry
    await waitForElement(page, 'Next');
    const nextClicked = await clickByLabel(page, 'Next');
    expect(nextClicked, 'Next button should be found and clicked').toBe(true);

    await stableShot(page, 'wizard-03-next-page.png', { fullPage: true });
  });

  test('Wizard can navigate back', async ({ page }) => {
    await page.goto('/standalone/wizard/wizard_test.html');
    await waitForWxApp(page);

    // Launch wizard using element registry
    await waitForElement(page, 'Launch Footprint Wizard');
    const launchClicked = await clickByLabel(page, 'Launch Footprint Wizard');
    expect(launchClicked, 'Launch Wizard button should be found').toBe(true);

    // Click Next using element registry
    await waitForElement(page, 'Next');
    const nextClicked = await clickByLabel(page, 'Next');
    expect(nextClicked, 'Next button should be found').toBe(true);

    // Let the Next page-transition commit before clicking Back (the Back/Next
    // buttons persist across pages, so there is no registry delta to poll on).
    await page.waitForTimeout(200); // eslint-disable-line -- documented interaction dwell: Next page-transition commit; no registry delta to poll

    // Click Back using element registry
    const backClicked = await clickByLabel(page, 'Back');
    expect(backClicked, 'Back button should be found and clicked').toBe(true);

    await stableShot(page, 'wizard-04-back-page.png', { fullPage: true });
  });

  test('Wizard can be cancelled', async ({ page }) => {
    await page.goto('/standalone/wizard/wizard_test.html');
    await waitForWxApp(page);

    // Launch wizard using element registry
    await waitForElement(page, 'Launch Footprint Wizard');
    const launchClicked = await clickByLabel(page, 'Launch Footprint Wizard');
    expect(launchClicked, 'Launch Wizard button should be found').toBe(true);

    // Click Cancel using element registry
    await waitForElement(page, 'Cancel');
    const cancelClicked = await clickByLabel(page, 'Cancel');
    expect(cancelClicked, 'Cancel button should be found and clicked').toBe(true);

    await stableShot(page, 'wizard-05-cancel.png', { fullPage: true });
  });
});
