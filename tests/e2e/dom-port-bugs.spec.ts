import { test, expect, tryLoadApp, getCanvasBox } from './utils/fixtures';

// Red-green reproductions for the two DOM-port bugs in
// docs/features/wx-dom-port/branch-review.md.
//
// Each standalone app (tests/apps/standalone/{textctrl-reentry,tooltip-lifetime})
// exercises the exact buggy path; the test is RED while the bug is present and
// GREEN after the wasm-layer fix.

function reproLine(logs: string[], name: string): string | undefined {
  return logs.find((l) => l.includes(`[REPRO] ${name}:`));
}

test.describe('wx DOM-port bug reproductions', () => {
  // textctrl.cpp OnDomEvent(INPUT) sets m_inDomInput=true, fires wxEVT_TEXT, then
  // resets it — but the reset is skipped if a handler throws, wedging the flag and
  // silently dropping every later programmatic value push. Driven through the real
  // path: typing fires a genuine DOM 'input' event whose wxEVT_TEXT handler throws
  // (caught at wx-dom.js's dispatch() boundary); a button then does a programmatic
  // ChangeValue() that must still reach the element.
  test('wxTextCtrl: a throwing wxEVT_TEXT handler must not wedge DOM sync', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/textctrl-reentry/textctrl-reentry_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);

    await expect
      .poll(() => testLogger.consoleLogs.some((l) => l.includes('[REPRO] textctrl ready')), {
        timeout: 30000,
        message: 'repro app should finish setup',
      })
      .toBe(true);

    const input = page.locator('input').first();
    await input.click();
    await input.pressSequentially('x'); // real DOM 'input' -> wxEVT_TEXT -> throw

    await page.getByRole('button', { name: 'Set Programmatic' }).click(); // ChangeValue

    // The programmatic value must reach the element. RED if the throw wedged
    // m_inDomInput (the element keeps the typed "x").
    await expect
      .poll(async () => await input.inputValue(), {
        timeout: 10000,
        message: 'programmatic ChangeValue must reach the <input> after a throwing handler',
      })
      .toBe('PROGRAMMATIC_OK');
  });

  // tooltip.cpp keeps gs_hoverWindow as a raw pointer dereferenced 600ms later by
  // the tooltip timer; nothing clears it when the window is destroyed, so a window
  // freed within the delay leaves a dangling pointer (UAF). The app arms the hover,
  // destroys the window, and self-reports whether the pointer was cleared.
  test('wxToolTip: the hover-window pointer must not outlive its window', async ({
    page,
    testLogger,
  }) => {
    const name = 'tooltip_hover_window_cleared_on_destroy';
    await page.goto('/standalone/tooltip-lifetime/tooltip-lifetime_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);

    await expect
      .poll(() => reproLine(testLogger.consoleLogs, name) ?? null, {
        timeout: 30000,
        message: `repro app should emit its [REPRO] ${name} result line`,
      })
      .not.toBeNull();

    const line = reproLine(testLogger.consoleLogs, name)!;
    expect(line, `repro line was: ${line}`).toContain(`[REPRO] ${name}: PASS`);
  });

  // stattext.cpp ellipsized the label only inside SetLabel(), at the control's
  // client size at that moment. A wxStaticText in a growable sizer cell (e.g.
  // gerbview's Layers Manager) is constructed narrow and widened later by layout,
  // but the DOM-port wxStaticText had no wxEVT_SIZE handler — so the label stayed
  // truncated to the early tiny width ("1..." instead of the layer name). The fix
  // re-ellipsizes on resize via UpdateLabel(). The app sets the long label while
  // narrow, then a button widens the control.
  test('wxStaticText: an ellipsized label must re-expand when the control is widened', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/stattext-ellipsize/stattext-ellipsize_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);

    await expect
      .poll(() => testLogger.consoleLogs.some((l) => l.includes('[REPRO] stattext ready')), {
        timeout: 30000,
        message: 'repro app should finish setup',
      })
      .toBe(true);

    // The middle of the label only renders when the control is wide enough; this
    // exact substring is ellipsized away at the narrow width.
    const fullNameVisible = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('span, div')).some((el) =>
          (el.textContent || '').includes('tinytapeout-demo-User_2'),
        ),
      );

    // Narrow: the long name is ellipsized away.
    expect(await fullNameVisible(), 'label starts ellipsized at the narrow width').toBe(false);

    await page.getByRole('button', { name: 'Grow' }).click();

    // Widening must re-ellipsize so the full label shows. RED before the wasm fix:
    // nothing re-ran ellipsization on resize, so the label stayed truncated.
    await expect
      .poll(fullNameVisible, {
        timeout: 10000,
        message: 'widening the control must re-ellipsize so the full label becomes visible',
      })
      .toBe(true);
  });

  // KiCad's ACTION_TOOLBAR derives from wxAuiToolBar, whose tool buttons are
  // painted "islands" inside ONE wxWindow. The C++ hover tooltip layer
  // (src/wasm/tooltip.cpp) is armed from wxApp::HandleMouseEvent only when the
  // hovered wxWindow changes, and BEFORE the motion is dispatched — so (1) the
  // first tool's tooltip often never arms (read before wxAuiToolBar::OnMotion
  // sets it) and (2) moving between tools on the same toolbar never re-arms.
  // The app logs each tool's #canvas-relative rect; we drive the real pointer
  // and assert the #wx-tooltip layer shows the hovered tool's text and updates.
  test('wxAuiToolBar: tooltip shows on hover and updates when moving between tools', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/tooltip-toolbar/tooltip-toolbar_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);

    await expect
      .poll(() => testLogger.consoleLogs.some((l) => l.includes('[REPRO] tooltip-toolbar ready')), {
        timeout: 30000,
        message: 'repro app should finish setup',
      })
      .toBe(true);

    // Tool rects (in #canvas-relative coords) logged by the app.
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const l of testLogger.consoleLogs) {
      const m = l.match(/\[REPRO\] toolrect (\S+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/);
      if (m) rects[m[1]] = { x: +m[2], y: +m[3], w: +m[4], h: +m[5] };
    }
    expect(rects['TOOLTIP_A'], 'tool A rect logged').toBeTruthy();
    expect(rects['TOOLTIP_B'], 'tool B rect logged').toBeTruthy();

    const canvas = await getCanvasBox(page);
    const center = (r: { x: number; y: number; w: number; h: number }) => ({
      x: canvas.x + r.x + r.w / 2,
      y: canvas.y + r.y + r.h / 2,
    });
    const a = center(rects['TOOLTIP_A']);
    const b = center(rects['TOOLTIP_B']);

    const readTooltip = () =>
      page.evaluate(() => {
        const el = document.getElementById('wx-tooltip');
        if (!el) return { visible: false, text: '' };
        const visible = el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
        return { visible, text: el.textContent || '' };
      });
    const shownText = async () => {
      const t = await readTooltip();
      return t.visible ? t.text : '';
    };

    // Settle the pointer off the toolbar, then hover tool A.
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height - 20);
    await page.mouse.move(a.x, a.y);

    // RED today: the tooltip often never arms for the first hovered tool.
    await expect
      .poll(shownText, {
        timeout: 4000,
        message: 'tooltip should show TOOLTIP_A when hovering tool A',
      })
      .toBe('TOOLTIP_A');

    // Move to tool B (same toolbar window). RED today: never re-armed, so it
    // stays on TOOLTIP_A or hides.
    await page.mouse.move(b.x, b.y);
    await expect
      .poll(shownText, {
        timeout: 4000,
        message: 'tooltip should update to TOOLTIP_B when moving to tool B',
      })
      .toBe('TOOLTIP_B');
  });

  test('wxAuiToolBar: registry tool entries carry the tool id (userId)', async ({ page, testLogger }) => {
    // The guide overlay maps toolbar buttons to KiCad actions through the
    // tool id (docs/features/overlay-system 0002 M2); auibar.cpp passes it to
    // wxWasmTrackElement, wx.js stores it as `userId`.
    await page.goto('/standalone/tooltip-toolbar/tooltip-toolbar_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);
    await expect
      .poll(() => testLogger.consoleLogs.some((l) => l.includes('[REPRO] tooltip-toolbar ready')), {
        timeout: 30000,
        message: 'repro app should finish setup',
      })
      .toBe(true);

    const ids = () =>
      page.evaluate(() =>
        (window as any).wxElementRegistry
          .findAllRendered({ elementType: 'tool' })
          .map((t: { tooltip: string; userId?: number }) => [t.tooltip, t.userId])
          .sort(),
      );
    // ID_TOOL_A = wxID_HIGHEST + 1 (wxID_HIGHEST is 5999).
    await expect
      .poll(ids, { timeout: 30000, message: 'all three tools registered with their ids' })
      .toEqual([
        ['TOOLTIP_A', 6000],
        ['TOOLTIP_B', 6001],
        ['TOOLTIP_C', 6002],
      ]);
  });
});
