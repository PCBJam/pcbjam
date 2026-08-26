// wxTextDataObject UTF-8 encoding regression (wasm clipboard truncation).
//
// Drives wxwidgets/tests/wasm/textdataobj_test.cpp (built by Makefile.wasm
// target `textdataobj`). The bug: without wxNEEDS_UTF8_FOR_TEXT_DATAOBJ the
// port's wxTextDataObject served UTF-32 for wxDF_UNICODETEXT; the wasm
// wxClipboard read it as UTF-8 and the JS write helper truncated at the first
// NUL — navigator.clipboard got exactly ONE character of any copy. In KiCad
// that surfaced as eeschema pasting a stray "(" SCH_TEXT (rendered as a small
// blue arc) instead of the copied symbol.
//
// The C++ side logs [WXTEST] PASS/FAIL lines for the wx-API-level contract;
// this spec asserts none failed AND that the browser clipboard ends up with
// the complete multi-line, non-ASCII string.
import { test, expect, waitForWxApp, clickByLabel } from './utils/fixtures';

// Must match TEST_UTF8 in wxwidgets/tests/wasm/textdataobj_test.cpp byte for byte.
const TEST_STRING = [
  '(kicad_sch (version 20250114)',
  '  (symbol (lib_id "Device:R") (value "10kµΩ¶→"))',
  ')',
].join('\n');

test.describe('wxTextDataObject UTF-8 encoding', () => {
  test('serves UTF-8 for wxDF_UNICODETEXT and round-trips the clipboard in full', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/textdataobj/textdataobj_test.html');
    await waitForWxApp(page);

    // Startup suite: pure data-object assertions (size/bytes/composite/SetData).
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[WXTEST] SUITE-DONE startup')),
      { message: 'startup checks should complete' }
    ).toBe(true);

    // Seed the clipboard so a silently-failed write cannot pass as success.
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL-BEFORE-COPY'));

    // The wxClipboard round-trip suspends via JSPI, so it runs from a button
    // handler — the port's supported suspension context.
    expect(await clickByLabel(page, 'Run Clipboard RoundTrip')).toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[WXTEST] SUITE-DONE clipboard')),
      { message: 'clipboard round-trip should complete' }
    ).toBe(true);

    // Browser-level contract: the FULL text reached navigator.clipboard
    // (the original bug left exactly one character here).
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(TEST_STRING);

    // Empty the browser clipboard, then drive a wx paste: it must fall back
    // to wxClipboard's local text cache (the round-trip copy) instead of
    // reporting the empty browser read as the result.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    expect(await clickByLabel(page, 'Run Cache Fallback')).toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[WXTEST] SUITE-DONE fallback')),
      { message: 'cache-fallback check should complete' }
    ).toBe(true);

    // wx-level contract: every [WXTEST] assertion passed. Assert on the
    // SUITE-DONE failure COUNTERS, not just the absence of FAIL lines — a
    // FAIL line that never reaches the console must not read as a pass.
    expect(testLogger.consoleLogs.filter(l => l.includes('[WXTEST] FAIL'))).toEqual([]);
    const counters = testLogger.consoleLogs
      .map(l => l.match(/\[WXTEST\] SUITE-DONE \w+ failures=(\d+)/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => parseInt(m[1], 10));
    expect(counters.length).toBe(3);
    expect(counters).toEqual([0, 0, 0]);

    // (The full-text browser assertion ran above, before the fallback step
    // deliberately emptied navigator.clipboard.)
  });
});
