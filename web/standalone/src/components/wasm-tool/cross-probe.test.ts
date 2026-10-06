import { describe, expect, it } from "vitest";
import {
  crossProbeChannelName,
  createCrossProbe,
  type ChannelLike,
  type CrossProbe,
  type CrossProbeNotice,
  type ProbeTool,
} from "./cross-probe";

/** In-memory BroadcastChannel: delivers synchronously to every OTHER member. */
function makeBus() {
  const members = new Set<ChannelLike>();
  const channel = (): ChannelLike => {
    const ch: ChannelLike = {
      onmessage: null,
      postMessage(message) {
        for (const other of members) {
          if (other !== ch) other.onmessage?.({ data: structuredClone(message) } as MessageEvent);
        }
      },
      close() {
        members.delete(ch);
      },
    };
    members.add(ch);
    return ch;
  };
  return { channel };
}

function makeClock() {
  let t = 1_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ at: t + ms, fn });
    },
    advance(ms: number) {
      t += ms;
      for (const timer of timers.splice(0).filter((x) => x.at <= t)) timer.fn();
    },
  };
}

interface FakeWindow {
  url: string;
  closed: boolean;
  focused: number;
  focus(): void;
}

function makeTab(
  bus: ReturnType<typeof makeBus>,
  clock: ReturnType<typeof makeClock>,
  tool: ProbeTool,
  opts: { blockPopups?: boolean; noFile?: boolean } = {},
) {
  const execs: string[] = [];
  const forced: boolean[] = [];
  const notices: CrossProbeNotice[] = [];
  const windows: FakeWindow[] = [];
  const channel = bus.channel();
  const cp: CrossProbe = createCrossProbe({
    tool,
    channel,
    urlFor: (other) => (opts.noFile ? null : `/p/demo/${other}`),
    openWindow: (url) => {
      if (opts.blockPopups) return null;
      const w: FakeWindow = {
        url,
        closed: false,
        focused: 0,
        focus() {
          this.focused += 1;
        },
      };
      windows.push(w);
      return w as unknown as Window;
    },
    exec: (cmd, force) => {
      execs.push(cmd);
      forced.push(force);
      return true;
    },
    notify: (n) => notices.push(n),
    log: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
  });
  /** A crash: the tab leaves the channel without sending bye. */
  const crash = () => channel.close();
  return { cp, execs, forced, notices, windows, crash };
}

describe("cross-probe transport", () => {
  it("delivers a plain probe to a ready tab of the target editor only", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema");
    const pcb = makeTab(bus, clock, "pcbnew");
    const pcb2 = makeTab(bus, clock, "pcbnew");
    sch.cp.markReady();
    pcb.cp.markReady();
    pcb2.cp.markReady();

    expect(sch.cp.send("pcbnew", "$SELECT: 0,FU1", false)).toBe(true);

    expect(pcb.execs).toEqual(["$SELECT: 0,FU1"]);
    expect(pcb2.execs).toEqual(["$SELECT: 0,FU1"]);
    expect(pcb.forced).toEqual([false]);
    expect(sch.execs).toEqual([]);
    expect(sch.windows).toEqual([]);
    expect(sch.notices).toEqual([]);
  });

  it("a plain probe with no peer opens nothing and says nothing", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema");
    sch.cp.markReady();

    sch.cp.send("pcbnew", "$SELECT: 0,FU1", false);
    clock.advance(1_000);

    expect(sch.windows).toEqual([]);
    expect(sch.notices).toEqual([]);
  });

  it("a loading tab ignores probes", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema");
    const pcb = makeTab(bus, clock, "pcbnew");
    sch.cp.markReady();

    sch.cp.send("pcbnew", "$CLEAR", false);

    expect(pcb.execs).toEqual([]);
  });

  it("an explicit probe with no peer opens the tab and replays on its ready", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema");
    sch.cp.markReady();

    sch.cp.send("pcbnew", "$SELECT: 0,FU1", true);
    expect(sch.windows.map((w) => w.url)).toEqual(["/p/demo/pcbnew"]);

    // The opened tab boots (joins as loading), then its open settles.
    const pcb = makeTab(bus, clock, "pcbnew");
    expect(pcb.execs).toEqual([]);
    clock.advance(5_000);
    pcb.cp.markReady();

    expect(pcb.execs).toEqual(["$SELECT: 0,FU1"]);
    expect(pcb.forced).toEqual([true]);
    // Replayed once only.
    pcb.cp.announce();
    expect(pcb.execs).toEqual(["$SELECT: 0,FU1"]);
  });

  it("a newer explicit probe replaces the pending one", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema");
    sch.cp.markReady();

    sch.cp.send("pcbnew", "$SELECT: 0,FU1", true);
    const pcb = makeTab(bus, clock, "pcbnew");
    sch.cp.send("pcbnew", "$SELECT: 0,FU2", true);
    pcb.cp.markReady();

    expect(pcb.execs).toEqual(["$SELECT: 0,FU2"]);
    // The second explicit probe focused the tab we opened, not a second one.
    expect(sch.windows).toHaveLength(1);
    expect(sch.windows[0]!.focused).toBe(1);
  });

  it("drops a pending probe after the time limit", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema");
    sch.cp.send("pcbnew", "$SELECT: 0,FU1", true);
    const pcb = makeTab(bus, clock, "pcbnew");
    clock.advance(121_000);
    pcb.cp.markReady();

    expect(pcb.execs).toEqual([]);
  });

  it("focuses a tab it opened; never opens a second one", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema");
    sch.cp.openOrFocus("pcbnew");
    const pcb = makeTab(bus, clock, "pcbnew");
    pcb.cp.markReady();

    sch.cp.openOrFocus("pcbnew");
    sch.cp.send("pcbnew", "$SELECT: 0,FU1", true);

    expect(sch.windows).toHaveLength(1);
    expect(sch.windows[0]!.focused).toBe(2);
    expect(pcb.execs).toEqual(["$SELECT: 0,FU1"]);
    expect(sch.notices).toEqual([]);
  });

  it("a peer it did not open gets the probe and the user a toast", () => {
    const bus = makeBus();
    const clock = makeClock();
    const pcb = makeTab(bus, clock, "pcbnew");
    pcb.cp.markReady();
    const sch = makeTab(bus, clock, "eeschema");
    sch.cp.markReady();

    sch.cp.send("pcbnew", "$SELECT: 0,FU1", true);
    expect(pcb.execs).toEqual(["$SELECT: 0,FU1"]);

    clock.advance(300);
    expect(sch.windows).toEqual([]);
    expect(sch.notices).toEqual([{ text: "The PCB editor is open in another tab." }]);
  });

  it("a known peer that never answers is treated as gone and the tab opens", () => {
    const bus = makeBus();
    const clock = makeClock();
    const pcb = makeTab(bus, clock, "pcbnew");
    const sch = makeTab(bus, clock, "eeschema");
    sch.cp.markReady();
    // The peer table knows pcb from its boot "here"; then it dies without a bye.
    pcb.crash();
    sch.cp.openOrFocus("pcbnew");
    expect(sch.windows).toEqual([]);
    clock.advance(300);

    expect(sch.windows.map((w) => w.url)).toEqual(["/p/demo/pcbnew"]);
    expect(sch.notices).toEqual([]);
  });

  it("a blocked popup becomes a toast with an open button", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema", { blockPopups: true });

    sch.cp.openOrFocus("pcbnew");

    expect(sch.notices).toHaveLength(1);
    expect(sch.notices[0]!.action?.label).toBe("Open PCB editor");
  });

  it("does nothing for the tab's own editor or a project without that file", () => {
    const bus = makeBus();
    const clock = makeClock();
    const sch = makeTab(bus, clock, "eeschema", { noFile: true });

    expect(sch.cp.openOrFocus("eeschema")).toBe(false);
    expect(sch.cp.openOrFocus("pcbnew")).toBe(true);
    expect(sch.windows).toEqual([]);
    expect(sch.notices).toEqual([]);
  });

  it("bye removes the peer, so the next explicit action opens a tab", () => {
    const bus = makeBus();
    const clock = makeClock();
    const pcb = makeTab(bus, clock, "pcbnew");
    const sch = makeTab(bus, clock, "eeschema");
    pcb.cp.dispose();

    sch.cp.openOrFocus("pcbnew");

    expect(sch.windows.map((w) => w.url)).toEqual(["/p/demo/pcbnew"]);
  });

  it("isolates users, projects and working copies by channel name", () => {
    const base = { user: "ada", scope: "acme", slug: "board", copy: null };
    const names = new Set([
      crossProbeChannelName(base),
      crossProbeChannelName({ ...base, user: "bob" }),
      crossProbeChannelName({ ...base, user: null }),
      crossProbeChannelName({ ...base, slug: "other" }),
      crossProbeChannelName({ ...base, copy: "c1" }),
    ]);
    expect(names.size).toBe(5);
  });
});
