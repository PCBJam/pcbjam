import { Page, TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export const MAIN_CANVAS = '#canvas';
export const LOGS_BASE_DIR = path.join(__dirname, '..', '..', 'logs');
export const WXWIDGETS_LOGS_DIR = path.join(LOGS_BASE_DIR, 'wxwidgets');
export const KICAD_LOGS_DIR = path.join(LOGS_BASE_DIR, 'kicad');

export interface TestLogger {
  consoleLogs: string[];
  errors: string[];
  cleanup: () => void;
}

// Ensure logs directory exists
export function ensureLogsDir(dir: string = LOGS_BASE_DIR) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Setup logging for a test - captures console and errors
export function setupTestLogger(page: Page): TestLogger {
  const consoleLogs: string[] = [];
  const errors: string[] = [];

  const consoleHandler = (msg: any) => {
    const type = msg.type();
    const text = msg.text();
    const timestamp = new Date().toISOString();
    consoleLogs.push(`[${timestamp}] [${type.toUpperCase()}] ${text}`);
  };

  const errorHandler = (err: Error) => {
    const timestamp = new Date().toISOString();
    const stack = err.stack || 'No stack trace available';
    errors.push(`[${timestamp}] [ERROR] ${err.message}\n${stack}`);
  };

  page.on('console', consoleHandler);
  page.on('pageerror', errorHandler);

  const cleanup = () => {
    page.off('console', consoleHandler);
    page.off('pageerror', errorHandler);
  };

  return { consoleLogs, errors, cleanup };
}

// Write logs to files after test completion
export function writeTestLogs(testName: string, logger: TestLogger, logsDir: string) {
  // Ensure logs directory exists
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Sanitize test name for filesystem
  const safeTestName = testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Always write console log file
  const logFile = path.join(logsDir, `${safeTestName}.log`);
  fs.writeFileSync(logFile, logger.consoleLogs.join('\n'));

  // Only write error file if there are errors (excluding favicon)
  const realErrors = logger.errors.filter(e => !e.includes('favicon'));
  if (realErrors.length > 0) {
    const errorFile = path.join(logsDir, `${safeTestName}.errors.log`);
    fs.writeFileSync(errorFile, realErrors.join('\n\n'));
  }
}

// Helper to get test file name without extension
export function getTestFileName(filePath: string): string {
  return path.basename(filePath, '.spec.ts');
}

// Log name for one run of a test: describe blocks + title, then the project —
// kicad-firefox and kicad-chromium run the same specs, and without it the later
// project overwrote the earlier one's log — and the retry number, if any.
export function getTestLogName(testInfo: TestInfo): string {
  const parts = [...testInfo.titlePath, testInfo.project.name];
  if (testInfo.retry > 0) parts.push(`retry${testInfo.retry}`);
  return parts.join(' - ');
}

// Helper to wait for app initialization
export async function waitForApp(page: Page, timeout = 30000) {
  await page.waitForSelector(MAIN_CANVAS, { state: 'visible', timeout });
  await page.waitForTimeout(500);
}

// Helper to try loading app with fallback
export async function tryLoadApp(page: Page, timeout = 15000): Promise<boolean> {
  try {
    await waitForApp(page, timeout);
    return true;
  } catch {
    return false;
  }
}

// Get canvas bounding box helper
export async function getCanvasBox(page: Page) {
  const canvas = page.locator(MAIN_CANVAS);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not found');
  return box;
}
