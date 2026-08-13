import * as fs from 'fs';
import * as path from 'path';

/**
 * Recursively clean all files in a directory (keeps directory structure).
 */
function cleanDirectory(dir: string): number {
  let count = 0;
  if (!fs.existsSync(dir)) return count;

  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        fs.unlinkSync(fullPath);
        count++;
      } else if (stat.isDirectory()) {
        count += cleanDirectory(fullPath);
      }
    } catch (error) {
      // A second local Playwright invocation can clean the same entry between
      // readdir/stat/unlink. Its successful removal satisfies this cleanup.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return count;
}

/**
 * Global setup for Playwright tests.
 * Cleans the logs directory (and subdirectories) before each test run.
 * Not on CI: the workspace starts empty there, and the suites (wx, asyncify,
 * kicad, perf) run as sequential steps of ONE job — cleaning here would wipe
 * the previous suite's logs out of the uploaded artifact.
 */
export default async function globalSetup() {
  if (process.env.CI) return;
  const logsDir = path.join(__dirname, 'logs');
  const count = cleanDirectory(logsDir);
  if (count > 0) {
    console.log(`[global-setup] Removed ${count} log files from ${logsDir}`);
  }
}
