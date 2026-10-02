import { test, expect } from "./fixtures";
import {
  TRIO_PCB,
  FP1,
  PAD1,
  PAD2,
  bootOpen,
  callHook,
  getPos,
  hasAbort,
  modelText,
  oracleSweep,
  renderDoc,
  settleConverged,
  startV2,
  type ToolCfg,
} from "./utils/trio";

// Use different nets on the two pads so an incorrect net-code mapping cannot
// pass by preserving only the number of connected pads.
const NETTED_PCB: ToolCfg = {
  ...TRIO_PCB,
  fixture: TRIO_PCB.fixture
    .replace('(net 0 "")', '(net 0 "") (net 1 "SIG") (net 2 "GND")')
    .replace(`(uuid "${PAD1}")`, `(net 1 "SIG") (uuid "${PAD1}")`)
    .replace(`(uuid "${PAD2}")`, `(net 2 "GND") (uuid "${PAD2}")`),
};

test("PCB peers retain pad nets after moving the same footprint in both directions", async ({
  context,
  testLogger,
}) => {
  test.setTimeout(420000);
  const A = await context.newPage();
  const B = await context.newPage();
  const peers = { tabs: [["A", A], ["B", B]] as const };
  const room = `pcb-pad-nets-${test.info().project.name}-${test.info().workerIndex}`;
  await bootOpen(A, NETTED_PCB);
  await bootOpen(B, NETTED_PCB);

  // Seed the writer's canonical file, as production does, so the initial room
  // already uses KiCad 10 net names rather than the fixture's legacy net codes.
  await startV2(A, { room, seedText: await modelText(A, NETTED_PCB) });
  await startV2(B, { room, editorMatchesDoc: true });
  await settleConverged(peers, NETTED_PCB);

  for (const [sender, receiver, dx] of [[A, B, 2000000], [B, A, -1000000]] as const) {
    const [x, y] = (await getPos(sender, FP1)).split(",").map(Number);
    expect(await callHook(sender, "kicadCollabTestMoveBoardItem", FP1, dx, 0)).toBe(true);
    await expect
      .poll(() => getPos(receiver, FP1), { timeout: 25000, intervals: [400] })
      .toBe(`${x! + dx},${y}`);

    for (const [, page] of peers.tabs) {
      const saved = await modelText(page, NETTED_PCB);
      expect(saved).toContain('(net "SIG")');
      expect(saved).toContain('(net "GND")');
      const rendered = await renderDoc(page);
      expect(rendered.err).toBeUndefined();
      expect(rendered.ok).toContain('(net "SIG")');
      expect(rendered.ok).toContain('(net "GND")');
    }
    await settleConverged(peers, NETTED_PCB);
    await oracleSweep(peers, NETTED_PCB);
  }

  expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  await A.close();
  await B.close();
});
