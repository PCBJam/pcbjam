import { test, expect } from './fixtures';
import {
  waitForEditorReady,
  waitForRenderedByLabel,
  findRenderedByType,
  stableShot,
} from '../e2e/utils/element-tracker';

/**
 * Footprint editor library tree (LIB_TREE) right-click.
 *
 * LIB_TREE::onItemContextMenu asks FOOTPRINT_EDITOR_CONTROL's tool menu for a
 * context menu via TOOL_MENU::ShowContextMenu(), which only marks the
 * CONDITIONAL_MENU dirty; the items are built when wxEVT_MENU_OPEN reaches it
 * (EDA_BASE_FRAME -> TOOL_DISPATCHER -> ACTION_MENU::OnMenuEvent). The DOM port
 * sent no wxEVT_MENU_OPEN, so the tree popped an empty menu strip, and it sat a
 * menu-bar height above the pointer (frame->PopupMenu(menu, ScreenToClient(mouse))).
 * The harness tree has no libraries, so the right-click lands on empty space:
 * the menu then holds the always-shown entries (Save).
 * wx-only repro: e2e/dataview-contextmenu.spec.ts.
 */
test('footprint editor: right-click in the library tree opens the populated menu at the pointer', async ({
  page,
}) => {
  await page.goto('/kicad/footprint_editor.html');
  await waitForEditorReady(page);

  const header = await waitForRenderedByLabel(page, 'Item', { elementType: 'columnheader' });
  const x = Math.round(header.centerX);
  const y = Math.round(header.centerY + header.height / 2 + 150);
  await page.mouse.click(x, y, { button: 'right' });

  await waitForRenderedByLabel(page, 'Save', { elementType: 'menuitem', parentId: 'popupmenu' });
  const items = await findRenderedByType(page, 'menuitem', { parentId: 'popupmenu' });
  expect(items.length, 'the context menu has entries').toBeGreaterThan(0);

  const box = await page.locator('.wx-menu-popup').boundingBox();
  expect(box, 'popup element present').not.toBeNull();
  expect(Math.abs(box!.x - x), 'popup left at the pointer').toBeLessThanOrEqual(2);
  expect(Math.abs(box!.y - y), 'popup top at the pointer').toBeLessThanOrEqual(2);
  await stableShot(page, 'lib-tree-context-menu-01-open.png');

  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await findRenderedByType(page, 'menuitem', { parentId: 'popupmenu' })).length)
    .toBe(0);
});
