import { test, expect } from './utils/fixtures';
import { findAllTreeItems, waitForWxApp, stableShot } from './utils/element-tracker';

/**
 * eeschema's Schematic Hierarchy pane = wxTreeCtrl with a hidden root, a
 * per-item wxBitmapBundle (16px dots) and a bold "current sheet". Regression
 * for two port bugs: the bundle's preferred LOGICAL size was reported at the
 * device-pixel size (32 on retina) so every row reserved twice the icon
 * height with the icon pinned to the row top; and an unfocused selection was
 * drawn black-on-highlight (wxSYS_COLOUR_LISTBOXHIGHLIGHTTEXT defaulted to the
 * window text colour while the generic renderer always paints HIGHLIGHT).
 */
test.describe('wxTreeCtrl hierarchy-pane configuration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/standalone/tree-hier/tree_hier_test.html');
    await waitForWxApp(page);
  });

  test('rows with 16px bundle icons stay text-height, not icon@2x-height', async ({ page }) => {
    const items = await findAllTreeItems(page);
    expect(items.length).toBe(5);
    const byY = [...items].sort((a, b) => a.screenY - b.screenY);
    // 10pt text ≈ 16px + 2px padding + 2px spacing; a 32px "logical" icon made this ~35.
    for (const it of byY) expect(it.height, `row "${it.label}"`).toBeLessThanOrEqual(24);
    const pitches = byY.slice(1).map((it, i) => it.screenY - byY[i].screenY);
    for (const p of pitches) expect(p).toBeLessThanOrEqual(24);
    await stableShot(page, 'tree-hier-01-loaded.png');
  });

  test('an unfocused selection is drawn light-on-highlight, not black-on-blue', async ({ page }) => {
    const items = await findAllTreeItems(page);
    const sel = items.find(it => it.label.startsWith('Arduino Leonardo'))!;
    expect(sel).toBeDefined();
    // Sample the label row at device resolution: the highlight (navy) must be
    // present and the glyph pixels on it must be light, never near-black.
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const px = await page.evaluate(
      ({ x, y, w, h, dpr }) => {
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        const ctx = canvas.getContext('2d')!;
        const r = canvas.getBoundingClientRect();
        const d = ctx.getImageData((x - r.x) * dpr, (y - r.y) * dpr, w * dpr, h * dpr).data;
        let navy = 0, dark = 0, light = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [R, G, B] = [d[i], d[i + 1], d[i + 2]];
          if (B > 90 && R < 40 && G < 40) navy++;
          else if (R < 60 && G < 60 && B < 60) dark++;
          else if (R > 200 && G > 200 && B > 200) light++;
        }
        return { navy, dark, light, total: d.length / 4 };
      },
      // Skip the leading 16px item icon (the "selected" dot is dark by design).
      { x: sel.screenX + 22, y: sel.screenY, w: sel.width - 22, h: sel.height, dpr }
    );
    expect(px.navy, 'highlight painted under the selected label').toBeGreaterThan(px.total * 0.2);
    expect(px.light, 'light glyph pixels on the highlight').toBeGreaterThan(px.total * 0.02);
    expect(px.dark, 'no black glyphs on the highlight').toBeLessThan(px.total * 0.01);
  });
});
