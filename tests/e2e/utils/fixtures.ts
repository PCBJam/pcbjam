import { test as base } from '@playwright/test';
import * as path from 'path';
import { setupTestLogger, writeTestLogs, TestLogger, MAIN_CANVAS, waitForApp, tryLoadApp, getCanvasBox, WXWIDGETS_LOGS_DIR, getTestFileName, getTestLogName } from './test-utils';
import { armHangDiagnostics } from './hang-diagnostics';

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

  testLogger: async ({ page }, use, testInfo) => {
    // Describe blocks + test title + project (+ retry)
    const testName = getTestLogName(testInfo);

    const logger = setupTestLogger(page);

    await use(logger);

    // Write logs to wxwidgets/<test-file>/ directory
    const testFileName = getTestFileName(testInfo.file);
    const logsDir = path.join(WXWIDGETS_LOGS_DIR, testFileName);
    writeTestLogs(testName, logger, logsDir);
    logger.cleanup();
  },
});

export { expect } from '@playwright/test';
export { MAIN_CANVAS, waitForApp, tryLoadApp, getCanvasBox };

// Element tracking utilities for semantic element identification
export * from './element-tracker';
