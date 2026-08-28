import { test, expect, type Page } from '@playwright/test';

/**
 * One un-unwrappable wire entry discards the WHOLE local-edit batch.
 *
 * Two tabs of the real app on the same board. An editor emits its local edits as
 * an items-wire delta — `{added, changed, removed}`, each entry one item's full
 * s-expr — which the binding converts with `itemsWireToDelta` and writes to the
 * shared Y.Doc; the other tab renders that doc. `itemsWireToDelta` calls
 * `unwrapWireItem` per entry inside a single loop, and `unwrapWireItem` THROWS on
 * an entry it cannot resolve to exactly one uuid-bearing item form. The throw
 * escapes the loop before `doc.transact`, so every OTHER entry in that message is
 * lost with it — silently: the throw lands in the C++ caller and surfaces only as
 * a bare pageerror.
 *
 * The unresolvable entry was real. The emit side serializes a non-footprint
 * item as `Format(item)` wrapped in a `(kicad_pcb … (layers …) <item>)`
 * envelope, and KiCad's board writer emits NOTHING for a footprint field —
 * `case PCB_FIELD_T: break;` (pcb_io_kicad_sexpr.cpp:411), correctly, because a
 * field is written by its footprint's own writer and is never standalone board
 * content. The result was an envelope with no item in it.
 *
 * Findings P-5 closed the emit side: `blobForItem` now refuses to blob a field
 * on its own (returns "") and `liftBlob` skips empty blobs, so the editor no
 * longer produces the hollow envelope. That contract is asserted below through
 * `kicadCollabTestItemBlob` (the same function `blobForItem` backs). The
 * receive-side guard is independent of it — any sender, any version, any
 * transient — so the poisoned entry is now built here in the exact shape the
 * writer used to emit: a board envelope with a layer table and no item.
 *
 * Seen in the field: "Update PCB from Schematic" produced a 67-entry `changed`
 * batch in which one entry was that empty envelope. All 67 were dropped, so two
 * footprints the schematic had just added existed on the syncing tab and nowhere
 * else — not in the room, not for any peer, and not after a reload.
 *
 * NOT covered here: the transient condition inside that sync's commit which lets
 * a field reach the serializer unlifted in the first place (`noteDirty` and
 * `liftBlob` both substitute a child's parent footprint, and every field on a
 * settled board is properly parented). Pinning that down needs an instrumented
 * wasm build. What this test holds is the consequence — where the damage is, and
 * what any fix has to close: one bad entry must not take the others with it.
 *
 * Regression test for the fix: `itemsWireToDelta` now SKIPS an entry it cannot
 * convert (reported via onSkip → console warn) instead of aborting the batch.
 * Before the fix this failed exactly as described above.
 */

const SCOPE = 'default';
const BOARD = `/${SCOPE}/projects/demo/demo.kicad_pcb`;

/** Wire entries are `{sexpr, parent}`; the emit side sends parent null for roots. */
type WireItem = { sexpr: string; parent: string | null };
type Mod = {
  kicadCollabSnapshotItems(): string;
  kicadCollabTestItemBlob(uuid: string): string;
};
type W = { Module: Mod; kicadCollab: { onItems?: (json: string) => void } };

async function bootBoard(page: Page, user: string): Promise<void> {
  await page.goto(`${BOARD}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: `${user}: board editor never reached the expected title`,
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(/demo — PCB Editor/i);
  await page.waitForFunction(
    () =>
      typeof (window as unknown as Partial<W>).Module?.kicadCollabTestItemBlob === 'function',
    null,
    { timeout: 60000 },
  );
  // The binding owns the emit slot; without it there is nothing to feed.
  await page.waitForFunction(
    () => typeof (window as unknown as Partial<W>).kicadCollab?.onItems === 'function',
    null,
    { timeout: 60000 },
  );
}

/** That footprint's own `(at …)` as this tab currently holds it. */
async function positionOf(page: Page, uuid: string): Promise<string> {
  return page.evaluate((id) => {
    const snap = JSON.parse(
      (window as unknown as W).Module.kicadCollabSnapshotItems(),
    ) as { added: WireItem[] };
    const blob = snap.added.find((w) => w.sexpr.includes(id));
    // The footprint's own `(at …)` is the first in its blob — layer and uuid
    // precede it, and every later one belongs to a child.
    return blob?.sexpr.match(/\(at [^)]*\)/)?.[0] ?? '(absent)';
  }, uuid);
}

/**
 * Hand the binding a local-edit delta exactly as the C++ emit does.
 *
 * The handler runs synchronously inside `onItems`, so a throw comes straight back
 * out; catching it in-page keeps the failure attributable to this message instead
 * of surfacing as an unrelated pageerror.
 */
async function emit(page: Page, changed: WireItem[]): Promise<string> {
  return page.evaluate((items) => {
    try {
      (window as unknown as W).kicadCollab.onItems!(
        JSON.stringify({ added: [], changed: items, removed: [] }),
      );
      return 'no throw';
    } catch (e) {
      return String(e);
    }
  }, changed);
}

const moveTo = (sexpr: string, pos: string) => sexpr.replace(/\(at [^)]*\)/, `(at ${pos})`);

/**
 * A target position derived from where the item CURRENTLY sits, offset by a
 * per-step delta. The room's doc persists across runs (and across the CI
 * engine projects sharing one server stack), so absolute coordinates would
 * leave a re-run moving an item onto itself — a vacuous no-change the final
 * assertions cannot distinguish from a discarded batch.
 */
const bumped = (sexpr: string, dx: number, dy: number): string => {
  const m = sexpr.match(/\(at (-?[\d.]+) (-?[\d.]+)/);
  if (!m) throw new Error('item has no (at x y)');
  return `${(parseFloat(m[1]!) + dx).toFixed(2)} ${(parseFloat(m[2]!) + dy).toFixed(2)}`;
};

test('a single un-unwrappable entry must not discard the rest of the batch', async ({
  page,
  context,
}) => {
  test.setTimeout(480000); // two full board boots

  const alice = page;
  await bootBoard(alice, 'alice');
  const bob = await context.newPage();
  await bootBoard(bob, 'bob');

  // ── the payloads, all straight out of the editor ──────────────────────────
  // Two footprints; the second one's field pins the P-5 emit contract.
  const picked = await alice.evaluate(() => {
    const M = (window as unknown as W).Module;
    const snap = JSON.parse(M.kicadCollabSnapshotItems()) as { added: WireItem[] };
    const fps: Array<{ uuid: string; sexpr: string; field?: string }> = [];
    for (const w of snap.added) {
      if (!/^\s*\(footprint\b/.test(w.sexpr)) continue;
      const uuid = w.sexpr.match(/\(uuid\s+"([^"]+)"\)/)?.[1];
      // A field is a `(property …)` INSIDE the footprint, carrying its own uuid.
      const field = w.sexpr.match(/\(property\s+"[^"]*"[^]*?\(uuid\s+"([^"]+)"\)/)?.[1];
      if (uuid) fps.push({ uuid, sexpr: w.sexpr, field });
    }
    const fp1 = fps[0];
    const fp2 = fps.find((f, i) => i > 0 && !!f.field);
    if (!fp1 || !fp2) return null;
    return {
      fp1,
      fp2,
      fieldBlob: M.kicadCollabTestItemBlob(fp2.field!),
      fpBlob: M.kicadCollabTestItemBlob(fp1.uuid),
    };
  });
  expect(picked, 'demo board should have two footprints, the second with a field').toBeTruthy();
  const { fp1, fp2, fieldBlob, fpBlob } = picked!;

  // P-5 contract (emit side): a field asked for on its own is NOT blobbed — the
  // serializer yields empty text, never the hollow envelope. A footprint asked
  // for the same way still serializes (bare, CTL_FOR_BOARD) with its uuid.
  expect(fieldBlob, 'P-5: a standalone field blob is empty text').toBe('');
  expect(fpBlob, 'footprint blob is the footprint form').toMatch(/^\s*\(footprint\b/);
  expect(fpBlob, 'footprint blob carries the item').toContain(`(uuid "${fp1.uuid}")`);

  // The poisoned entry, in the exact shape the writer used to emit for a field:
  // a board envelope with a layer table and no uuid-bearing item in it. This is
  // the entry `unwrapWireItem` cannot resolve (0 candidates).
  const hollowBlob =
    '(kicad_pcb (version 20240108) (generator "pcbnew") (generator_version "9.0")\n' +
    '  (general (thickness 1.6) (legacy_teardrops no))\n' +
    '  (paper "A4")\n' +
    '  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))\n' +
    ')';
  expect(hollowBlob, 'hollow blob contains NO item — the defect shape').not.toContain('(uuid');

  const fp2Before = await positionOf(bob, fp2.uuid);
  expect(fp2Before, 'bob should already hold fp2').not.toBe('(absent)');

  // ── 1. control: a lone footprint entry propagates ─────────────────────────
  // Asserted as a CHANGE from what bob held, so it cannot pass vacuously if a
  // previous run left the board at the target coordinates.
  const fp1Before = await positionOf(bob, fp1.uuid);
  expect(
    await emit(alice, [{ sexpr: moveTo(fp1.sexpr, bumped(fp1.sexpr, 1.1, 2.2)), parent: null }]),
  ).toBe('no throw');
  await expect
    .poll(() => positionOf(bob, fp1.uuid), {
      message: 'bob never received a lone footprint entry — the harness is wrong, not the code',
      timeout: 30000,
      intervals: [500],
    })
    .not.toBe(fp1Before);
  const fp1AfterControl = await positionOf(bob, fp1.uuid);

  // ── 2. the defect: a good entry batched with the hollow entry ─────────────
  // Deliberately NOT asserted on: today this returns the `unwrapWireItem: …
  // found 0` throw, and once the conversion skips an entry it cannot convert it
  // will return 'no throw'. Requiring either would pin the test to one side of
  // the fix. The invariant is the one asserted at the end — the GOOD entry in
  // this batch must reach the peer — so the outcome is recorded, not enforced.
  const reproEmit = await emit(alice, [
    { sexpr: moveTo(fp2.sexpr, bumped(fp2.sexpr, 3.3, 4.4)), parent: null },
    { sexpr: hollowBlob, parent: null },
  ]);
  test.info().annotations.push({ type: 'repro emit', description: reproEmit });

  // ── 3. fence: a later message arriving proves the earlier one is not merely
  // in flight. No sleep, no flake — ordering does the waiting.
  expect(
    await emit(alice, [{ sexpr: moveTo(fp1.sexpr, bumped(fp1.sexpr, 5.5, 6.6)), parent: null }]),
  ).toBe('no throw');
  await expect
    .poll(() => positionOf(bob, fp1.uuid), {
      message: 'the fence message never arrived, so the negative assertion below cannot be trusted',
      timeout: 30000,
      intervals: [500],
    })
    .not.toBe(fp1AfterControl);

  // The batch was discarded whole: fp2 never moved for the peer.
  expect(
    await positionOf(bob, fp2.uuid),
    'fp2 moved in the same batch as the un-unwrappable entry and was discarded with it',
  ).not.toBe(fp2Before);
});
