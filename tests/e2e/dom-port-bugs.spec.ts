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
  // (caught by wxEvtHandler::SafelyProcessEvent; the reducer app elects to keep
  // its main loop running); a button then does a programmatic ChangeValue() that
  // must still reach the element.
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

  test('wxTextCtrl: queued input events keep their receipt-time values while the owner is parked', async ({
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

    await page.getByRole('button', { name: 'Block Owner' }).click();
    await expect
      .poll(() => testLogger.consoleLogs.some((l) => l.includes('[DOM_INGRESS] block-start')), {
        timeout: 10000,
        message: 'the dispatch owner should park before browser input arrives',
      })
      .toBe(true);

    // Dispatch both events in one browser task. The live DOM value is already
    // "second" by the time native admission resumes, so a bridge that queues
    // only the DOM id/kind reports "second" twice. Each event envelope must
    // instead retain the immutable value observed at its own receipt.
    await page.locator('input').first().evaluate((node) => {
      const input = node as HTMLInputElement;
      input.value = 'first';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = 'second';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect
      .poll(
        () =>
          testLogger.consoleLogs
            .filter((l) => l.includes('[DOM_INGRESS] value='))
            .map((l) => l.slice(l.indexOf('[DOM_INGRESS] value=') + '[DOM_INGRESS] value='.length)),
        {
          timeout: 10000,
          message: 'both queued input envelopes should dispatch in receipt order',
        },
      )
      .toEqual(['first', 'second']);
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

  // The WASM timer bridge treats an unowned timer as Ordinary work. Ordinary
  // work correctly waits behind a parked root owner, so the old tooltip timer
  // (a derived wxTimer whose default owner was itself) could never fire while
  // ShowModal() held that owner. The tooltip layer must bind each arm to the
  // exact hovered wxWindow; only that modal scope and lease generation may run
  // the delivery. Other unowned timers remain Ordinary.
  test('wxToolTip: a window-owned tooltip timer fires inside its exact modal lease', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/tooltip-lifetime/tooltip-lifetime_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);

    await page.getByRole('button', { name: 'Open Modal Tooltip', exact: true }).click();
    await expect(
      page.locator('#window-container .window-titlebar-text').filter({
        hasText: /^Tooltip Modal$/,
      }),
      'the reducer modal should remain open while its opener is parked',
    ).toBeVisible({ timeout: 10000 });

    // The C++ reducer queued the same wxWasmTooltipOnHoverChange() hook used by
    // wxApp::HandleMouseEvent before entering ShowModal(). Wait until the modal
    // pump admits that call. Using the focused hook avoids an unrelated DOM
    // coordinate/scroll mismatch in this secondary-window standalone harness.
    const armName = 'tooltip_modal_timer_armed';
    await expect.poll(
      () => reproLine(testLogger.consoleLogs, armName) ?? '',
      { timeout: 10000 },
    ).toContain(`[REPRO] ${armName}: PASS`);

    const visibleTooltipText = () =>
      page.evaluate(() => {
        const tooltip = document.getElementById('wx-tooltip');
        if (!tooltip) return '';
        const visible = tooltip.style.display !== 'none'
          && getComputedStyle(tooltip).display !== 'none';
        return visible ? tooltip.textContent || '' : '';
      });

    await expect.poll(visibleTooltipText, {
      timeout: 4000,
      intervals: [25, 50, 100],
      message: 'the arm-time modal owner should admit its tooltip delivery',
    }).toBe('MODAL_TOOLTIP');

    await page
      .locator('#window-container button.wx-dom-control', { hasText: /^Close$/ })
      .click();
    await expect(
      page.locator('#window-container .window-titlebar-text').filter({
        hasText: /^Tooltip Modal$/,
      }),
      'closing the modal should destroy the exact tooltip target',
    ).toBeHidden({ timeout: 10000 });
    await expect.poll(visibleTooltipText, {
      timeout: 2000,
      message: 'destroying the target should hide and cancel its tooltip',
    }).toBe('');
  });

  // DOM controls in a secondary wx top-level are children of
  // #window-container, which a host is allowed to place independently from
  // #canvas. The generated standalone shell puts it after a viewport-height
  // canvas in document flow. Scrolling the real button into view therefore
  // gives it a different browser client origin from the canvas. Mouse
  // forwarding must reconstruct the control's wx screen point; subtracting
  // the canvas rect drops the event at modal-scope validation before dispatch.
  test('DOM mouse forwarding preserves wx screen coordinates after secondary-window scroll', async ({
    page,
    testLogger,
  }) => {
    const readyName = 'dom_pointer_scroll_ready';
    const targetName = 'dom_pointer_scroll_target';

    await page.goto('/standalone/tooltip-lifetime/tooltip-lifetime_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);

    await page.getByRole('button', {
      name: 'Open Pointer Scroll Modal',
      exact: true,
    }).click();
    await expect(
      page.locator('#window-container .window-titlebar-text').filter({
        hasText: /^Pointer Scroll Modal$/,
      }),
      'the pointer reducer modal should be open',
    ).toBeVisible({ timeout: 10000 });

    await expect.poll(
      () => reproLine(testLogger.consoleLogs, readyName) ?? '',
      {
        timeout: 10000,
        message: 'the reducer should publish the native target rectangle',
      },
    ).toContain(`[REPRO] ${readyName}: PASS`);

    const ready = reproLine(testLogger.consoleLogs, readyName)!;
    const nativeMatch = ready.match(/target=(-?\d+),(-?\d+),(\d+),(\d+)/);
    expect(nativeMatch, `native target geometry was: ${ready}`).not.toBeNull();
    const nativeRect = {
      x: Number(nativeMatch![1]),
      y: Number(nativeMatch![2]),
      width: Number(nativeMatch![3]),
      height: Number(nativeMatch![4]),
    };

    const target = page.getByRole('button', {
      name: 'Pointer Scroll Target',
      exact: true,
    });
    await target.evaluate((node) => {
      node.scrollIntoView({ block: 'center', inline: 'center' });
    });

    const geometry = await target.evaluate((node, wxRect) => {
      const targetRect = node.getBoundingClientRect();
      const canvasRect = document.getElementById('canvas')!.getBoundingClientRect();
      const clientX = targetRect.left + targetRect.width / 2;
      const clientY = targetRect.top + targetRect.height / 2;
      const legacyX = Math.round(clientX - canvasRect.left);
      const legacyY = Math.round(clientY - canvasRect.top);
      return {
        scrollY: window.scrollY,
        clientX,
        clientY,
        legacyX,
        legacyY,
        legacyHitsNative:
          legacyX >= wxRect.x
          && legacyX < wxRect.x + wxRect.width
          && legacyY >= wxRect.y
          && legacyY < wxRect.y + wxRect.height,
        canvasTop: canvasRect.top,
        targetTop: targetRect.top,
      };
    }, nativeRect);

    expect(geometry.scrollY,
      `secondary control should require document scroll: ${JSON.stringify(geometry)}`)
      .toBeGreaterThan(0);
    expect(geometry.legacyHitsNative,
      `legacy canvas-relative point should miss: ${JSON.stringify(geometry)}`)
      .toBe(false);

    // This is a trusted Playwright pointer move through the browser event
    // pipeline. No diagnostic hook synthesizes the wx event.
    await page.mouse.move(geometry.clientX, geometry.clientY);

    await expect.poll(
      () => reproLine(testLogger.consoleLogs, targetName) ?? '',
      {
        timeout: 10000,
        message: 'the real pointer should reach the exact native modal target',
      },
    ).toContain(`[REPRO] ${targetName}: PASS`);

    await page.getByRole('button', {
      name: 'Close Pointer Modal',
      exact: true,
    }).click();
    await expect(
      page.locator('#window-container .window-titlebar-text').filter({
        hasText: /^Pointer Scroll Modal$/,
      }),
      'the pointer reducer modal should close cleanly',
    ).toBeHidden({ timeout: 10000 });
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
});
