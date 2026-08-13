import { test as base } from '@playwright/test';
import * as path from 'path';
import { setupTestLogger, writeTestLogs, TestLogger, MAIN_CANVAS, waitForApp, tryLoadApp, getCanvasBox, KICAD_LOGS_DIR, getTestFileName } from '../e2e/utils/test-utils';
import { installNgspiceServiceStub } from './utils/ngspice-service';
import { installOccServiceStub } from './utils/occ-service';

// Extend base test with automatic logging
export const test = base.extend<{
  testLogger: TestLogger;
}>({
  // Every harness page gets the occ_service provider ambiently (standalone
  // parity: boot.ts installs it whenever the editor bundle boots). Init-script
  // based, so it exists from document start on every navigation; the worker
  // itself is only fetched on the first occ request, so specs can still assert
  // the lazy-load boundary.
  page: async ({ page }, use) => {
    await installOccServiceStub(page);
    // The ngspice_service provider follows the same ambient pattern (the
    // standalone installs it for every kicad_editor boot); the worker is only
    // fetched on the first simulator request.
    await installNgspiceServiceStub(page);
    try {
      await use(page);
    } finally {
      if (!page.isClosed()) {
        await page.evaluate(() => {
          (globalThis as any).__ngspiceServiceTestHooks?.dispose?.();
        }).catch(() => {
          // A navigation or page close can destroy the execution context first.
        });
      }
    }
  },

  testLogger: async ({ page }, use, testInfo) => {
    // Build test name from describe block + test title
    const testName = testInfo.titlePath.join(' - ');

    const logger = setupTestLogger(page);

    await use(logger);

    // Write logs to kicad/<test-file>/ directory
    const testFileName = getTestFileName(testInfo.file);
    const logsDir = path.join(KICAD_LOGS_DIR, testFileName);
    writeTestLogs(testName, logger, logsDir);
    logger.cleanup();
  },
});

export { expect } from '@playwright/test';
export { MAIN_CANVAS, waitForApp, tryLoadApp, getCanvasBox };
