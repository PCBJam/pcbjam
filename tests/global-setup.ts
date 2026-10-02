import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The collab harness bundles the kicad specs inject with page.addScriptTag.
// Built HERE, once per run, before any worker starts — the specs used to
// rebuild them in beforeAll (per worker, in place), and a worker injecting a
// bundle while another rewrote it got a truncated script (see
// collab/atomic-build.mjs).
const COLLAB_BUILDS = ['build.mjs', 'build-integrity.mjs', 'build-sync-audit.mjs'];

function buildCollabBundles(): void {
  for (const script of COLLAB_BUILDS) {
    execFileSync(process.execPath, [path.join('collab', script)], { cwd: __dirname, stdio: 'inherit' });
  }
}

/**
 * Recursively clean all files in a directory (keeps directory structure).
 */
function cleanDirectory(dir: string): number {
  let count = 0;
  if (!fs.existsSync(dir)) return count;

  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      fs.unlinkSync(fullPath);
      count++;
    } else if (stat.isDirectory()) {
      count += cleanDirectory(fullPath);
    }
  }
  return count;
}

/**
 * Global setup for Playwright tests.
 * Builds the collab bundles, then cleans the logs directory (and subdirectories) before each test run.
 * Not on CI: the workspace starts empty there, and the suites (wx, asyncify,
 * kicad, perf) run as sequential steps of ONE job — cleaning here would wipe
 * the previous suite's logs out of the uploaded artifact.
 */
export default async function globalSetup() {
  buildCollabBundles();
  if (process.env.CI) return;
  const logsDir = path.join(__dirname, 'logs');
  const count = cleanDirectory(logsDir);
  if (count > 0) {
    console.log(`[global-setup] Removed ${count} log files from ${logsDir}`);
  }
}
