import { test, expect, tryLoadApp } from './utils/fixtures';

// Red-green reproduction for wxCursor::Install() on an invalid cursor (src/wasm/cursor.cpp).
//
// wxEndBusyCursor() restores the global cursor; when none was set before
// wxBeginBusyCursor() that is wxCursor() with no ref data, and Install() read its type
// through a null pointer. With ASSERTIONS (every -O0 link: these test apps, KiCad's
// --release build) Emscripten's stack cookie at address 8 makes that "type" negative,
// setCursor() in wx.js looks up a bitmap that does not exist and throws, and under
// ~wxBusyCursor the exception terminates the runtime. KiCad opens every schematic
// inside a wxBusyCursor (SCH_EDIT_FRAME::OpenProjectFiles), so the --release
// kicad_editor aborted on any schematic.
//
//   RED  (bug present): the first check throws a TypeError ("reading 'width'").
//   GREEN (fixed):      every check leaves the canvas cursor at 'default'.

const CHECKS = ['busycursor_set_null_cursor', 'busycursor_begin_end', 'busycursor_scope'];

function reproLine(logs: string[], name: string): string | undefined {
  return logs.find((l) => l.includes(`[REPRO] ${name}:`));
}

// the bug's signature: setCursor() throwing for a cursor bitmap that does not exist, or the
// runtime terminating on it
function crashLine(logs: string[]): string | undefined {
  return logs.find((l) => /reading 'width'|libc\+\+abi: terminating|native code called abort/.test(l));
}

test.describe('wxCursor::Install on an invalid cursor', () => {
  test('busy cursor without a prior global cursor restores the default pointer', async ({ page, testLogger }) => {
    await page.goto('/standalone/busy-cursor/busy-cursor_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);

    for (const name of CHECKS) {
      await expect
        .poll(() => reproLine(testLogger.consoleLogs, name) ?? crashLine(testLogger.consoleLogs) ?? null, {
          timeout: 30000,
          message: `repro app should emit its [REPRO] ${name} result line`,
        })
        .not.toBeNull();
      expect(crashLine(testLogger.consoleLogs), 'installing the invalid cursor threw').toBeUndefined();
      const line = reproLine(testLogger.consoleLogs, name)!;
      expect(line, `repro line was: ${line}`).toContain(`[REPRO] ${name}: PASS`);
    }
  });
});
