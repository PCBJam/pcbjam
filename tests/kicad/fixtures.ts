import { test as base } from '@playwright/test';
import * as path from 'path';
import { setupTestLogger, writeTestLogs, TestLogger, MAIN_CANVAS, waitForApp, tryLoadApp, getCanvasBox, KICAD_LOGS_DIR, getTestFileName, getTestLogName } from '../e2e/utils/test-utils';
import { armHangDiagnostics } from '../e2e/utils/hang-diagnostics';
import { installNgspiceServiceStub } from './utils/ngspice-service';
import { installOccServiceStub } from './utils/occ-service';

// Extend base test with automatic logging
export const test = base.extend<{
  testLogger: TestLogger;
  hangDiagnostics: void;
}>({
  // Auto: every test gets the about-to-time-out process dump (see hang-diagnostics.ts).
  hangDiagnostics: [
    async ({}, use, testInfo) => {
      const finish = armHangDiagnostics(testInfo);
      await use();
      await finish();
    },
    { auto: true },
  ],

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
    await use(page);
  },

  testLogger: async ({ page }, use, testInfo) => {
    // Describe blocks + test title + project (+ retry)
    const testName = getTestLogName(testInfo);

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
