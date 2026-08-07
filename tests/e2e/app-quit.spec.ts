import { test, expect, waitForApp } from './utils/fixtures';

// D5 (docs/features/async/22): the main loop runs on a scheduler context and
// OnRun/main() return at startup, so a real app quit must travel the DETACHED
// teardown path — the loop exits on its context, latches the shim DEAD ("main
// loop exited"), and runs OnExit + wxUninitialize there. Nothing else in the
// battery drives an app exit, so this spec is the teardown gate doc 22's D5
// entry asks for. Intentionally takes no screenshots.
test.describe('App quit (detached main-loop teardown)', () => {
  test('quit runs the detached teardown cleanly', async ({ page, testLogger }) => {
    const fatal: string[] = [];
    page.on('pageerror', (err) => fatal.push(String(err)));

    await page.goto('/minimal_test.html');
    await waitForApp(page);

    // Close the main frame exactly as File->Quit would (wx_test_quit is the
    // app's EMSCRIPTEN_KEEPALIVE hook). The frame's pending-delete drains on a
    // later idle tick, the last top-level window's destruction ends the main
    // loop, and the loop context runs the teardown.
    await page.evaluate(() => (window as any).Module._wx_test_quit());

    // The S6 latch names the exit; "clean" means no queued work was stranded.
    await expect
      .poll(
        () =>
          testLogger.consoleLogs.find((l) =>
            l.includes('[wx-scheduler] shutdown (main loop exited)')
          ) ?? null,
        { timeout: 20000 }
      )
      .not.toBeNull();

    const all = testLogger.consoleLogs.join('\n');
    expect(all).toContain('shutdown (main loop exited) clean');

    // The teardown itself must not trap or trip the scheduler's guards.
    expect(all).not.toContain('Aborted');
    expect(all).not.toContain('unreachable executed');
    expect(all).not.toContain('[sched-ctx] REFUSED');
    expect(fatal, `page errors: ${fatal.join('\n')}`).toHaveLength(0);
  });
});
