import { describe, expect, it, vi } from "vitest";
import { CONSOLE_KEPT_CHARS, createConsoleStore, readable } from "./live-console";

const ESC = "\u001b";

describe("a chip's text as a console shows it", () => {
  it("makes every line end one line feed", () => {
    expect(readable("", "a\r\nb\nc\rd")).toEqual({ text: "a\nb\nc\nd", carry: "" });
  });

  it("waits with a carriage return at the end of a piece: the line feed may follow", () => {
    const first = readable("", "ready\r");
    expect(first).toEqual({ text: "ready", carry: "\r" });
    expect(readable(first.carry, "\n> ")).toEqual({ text: "\n> ", carry: "" });
    // and when none follows, it was a line end by itself
    expect(readable(first.carry, "next")).toEqual({ text: "\nnext", carry: "" });
  });

  it("leaves out the colours of an ESP-IDF log line, also when a piece ends inside one", () => {
    expect(readable("", `${ESC}[0;32mI (23) main_task: Started${ESC}[0m\n`).text).toBe("I (23) main_task: Started\n");
    const first = readable("", `boot${ESC}[0;3`);
    expect(first).toEqual({ text: "boot", carry: `${ESC}[0;3` });
    expect(readable(first.carry, "2mI (1) x\n")).toEqual({ text: "I (1) x\n", carry: "" });
    const lone = readable("", `a${ESC}`);
    expect(lone).toEqual({ text: "a", carry: ESC });
    expect(readable(lone.carry, "[1mb")).toEqual({ text: "b", carry: "" });
  });

  it("leaves out the other control characters, and keeps tabs", () => {
    expect(readable("", "a\u0007b\u0000c\td\u007f")).toEqual({ text: "abc\td", carry: "" });
  });

  it("does not hold back text for an escape character that starts no sequence", () => {
    expect(readable("", `a${ESC}x and a long way on`)).toEqual({ text: "ax and a long way on", carry: "" });
  });
});

function store(over: { canSend?: () => boolean; send?: (name: string, bytes: Uint8Array) => Promise<void> } = {}) {
  const sent: [string, string][] = [];
  const send = vi.fn(
    over.send ??
      (async (name: string, bytes: Uint8Array) => {
        sent.push([name, new TextDecoder().decode(bytes)]);
      }),
  );
  const s = createConsoleStore({ send, canSend: over.canSend ?? (() => true) });
  s.reset([
    { name: "uno_1", ref: "U1" },
    { name: "c3_2", ref: "U2" },
  ]);
  return { s, send, sent };
}

describe("the serial consoles of a run", () => {
  it("keep what each chip sent, apart, in one stretch while nothing else happens", () => {
    const { s } = store();
    expect(s.chips).toEqual([
      { name: "uno_1", ref: "U1" },
      { name: "c3_2", ref: "U2" },
    ]);
    expect(s.printed).toBe(false);
    s.out("uno_1", "ready\r\n> ");
    s.out("c3_2", "boot\n");
    s.out("uno_1", "more");
    expect(s.entries("uno_1")).toEqual([{ kind: "out", text: "ready\n> more" }]);
    expect(s.entries("c3_2")).toEqual([{ kind: "out", text: "boot\n" }]);
    expect(s.printed).toBe(true);
    // a chip the run does not have: nothing is kept
    s.out("other", "x");
    expect(s.entries("other")).toEqual([]);
  });

  it("show a typed line where it was typed, after the chip took it", async () => {
    const { s, sent } = store();
    s.out("uno_1", "> ");
    await s.send("uno_1", "on\n");
    s.out("uno_1", "the LED is on\n> ");
    expect(sent).toEqual([["uno_1", "on\n"]]);
    expect(s.entries("uno_1")).toEqual([
      { kind: "out", text: "> " },
      { kind: "in", text: "on\n" },
      { kind: "out", text: "the LED is on\n> " },
    ]);
  });

  it("send a typed line as UTF-8 bytes", async () => {
    const bytes: number[][] = [];
    const { s } = store({ send: async (_name, b) => void bytes.push([...b]) });
    await s.send("uno_1", "é\n");
    expect(bytes).toEqual([[0xc3, 0xa9, 0x0a]]);
  });

  it("do not send, and say why, when nothing runs or the chip is not there", async () => {
    let running = false;
    const { s, send } = store({ canSend: () => running });
    expect(s.canSend).toBe(false);
    await expect(s.send("uno_1", "on\n")).rejects.toThrow("Nothing runs: press Play first.");
    running = true;
    expect(s.canSend).toBe(true);
    await expect(s.send("gone", "on\n")).rejects.toThrow("This chip is not in the running circuit.");
    expect(send).not.toHaveBeenCalled();
    expect(s.entries("uno_1")).toEqual([]);
  });

  it("show nothing as typed when the engine did not take it", async () => {
    const { s } = store({
      send: async () => {
        throw new Error("the circuit has no part uno_1");
      },
    });
    await expect(s.send("uno_1", "on\n")).rejects.toThrow("the circuit has no part uno_1");
    expect(s.entries("uno_1")).toEqual([]);
  });

  it("put a word of the simulator on a line of its own", () => {
    const { s } = store();
    s.out("uno_1", "> ");
    s.note("uno_1", "reset went low: the chip is held in reset");
    s.out("uno_1", "ready\n");
    expect(s.entries("uno_1")).toEqual([
      { kind: "out", text: "> \n" },
      { kind: "note", text: "reset went low: the chip is held in reset\n" },
      { kind: "out", text: "ready\n" },
    ]);
    // a word before the chip printed anything does not count as printing
    const fresh = store().s;
    fresh.note("uno_1", "the chip has no program");
    expect(fresh.printed).toBe(false);
    expect(fresh.entries("uno_1")).toEqual([{ kind: "note", text: "the chip has no program\n" }]);
  });

  it("keep a problem apart from a note, and count the problems of each chip", () => {
    const { s } = store();
    expect(s.troubled).toBe(false);
    s.out("uno_1", "> ");
    s.note("uno_1", "reset went low: the chip is held in reset");
    expect(s.troubled).toBe(false);
    s.problem("uno_1", "the chip has no program");
    expect(s.entries("uno_1")).toEqual([
      { kind: "out", text: "> \n" },
      { kind: "note", text: "reset went low: the chip is held in reset\n" },
      { kind: "problem", text: "the chip has no program\n" },
    ]);
    expect(s.troubled).toBe(true);
    expect(s.problems("uno_1")).toBe(1);
    expect(s.problems("c3_2")).toBe(0);
    // a problem is not something the chip printed
    expect(s.printed).toBe(true);
    const quiet = store().s;
    quiet.problem("c3_2", "the enable pin is not high");
    expect(quiet.printed).toBe(false);
    expect(quiet.troubled).toBe(true);
    // Clear takes the mark off the chip; a new run starts without trouble
    s.clear("uno_1");
    expect(s.problems("uno_1")).toBe(0);
    s.reset([{ name: "uno_1", ref: "U1" }]);
    expect(s.troubled).toBe(false);
    // a chip the run does not have
    s.problem("other", "x");
    expect(s.troubled).toBe(false);
  });

  it("say how much did not arrive when a chip prints faster than it can be shown", () => {
    const { s } = store();
    s.out("uno_1", "line 1\nline", 5000);
    expect(s.entries("uno_1")).toEqual([
      { kind: "out", text: "line 1\nline\n" },
      { kind: "note", text: "... 5000 characters were left out: the chip prints faster than they can be shown\n" },
    ]);
  });

  it("keep the newest text: the oldest lines go, whole", () => {
    const { s } = store();
    const line = (n: number) => `line ${String(n).padStart(6, "0")}\n`; // 12 characters
    const lines = Math.ceil(CONSOLE_KEPT_CHARS / 12) + 500;
    for (let from = 0; from < lines; from += 100) {
      let piece = "";
      for (let n = from; n < from + 100; n++) piece += line(n);
      s.out("uno_1", piece);
    }
    expect(s.cut("uno_1")).toBe(true);
    const text = s.entries("uno_1").map((e) => e.text).join("");
    expect(text.length).toBeLessThanOrEqual(CONSOLE_KEPT_CHARS);
    expect(text.length).toBeGreaterThan(CONSOLE_KEPT_CHARS * 0.85);
    expect(text.startsWith("line ")).toBe(true); // it starts at a line's start
    expect(text.endsWith(line(lines - 1 + (100 - (lines % 100)) % 100))).toBe(true);
    // the other chip's console is its own
    expect(s.cut("c3_2")).toBe(false);
  });

  it("drop whole stretches first, then the start of the oldest", () => {
    const { s } = store();
    s.out("uno_1", "old\n");
    s.note("uno_1", "a note");
    s.out("uno_1", `${"x".repeat(CONSOLE_KEPT_CHARS)}\n`);
    const entries = s.entries("uno_1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("out");
    expect(entries[0]!.text.length).toBeLessThanOrEqual(CONSOLE_KEPT_CHARS);
    expect(s.cut("uno_1")).toBe(true);
  });

  it("empty one console on Clear, and all of them for a new run", () => {
    const { s } = store();
    s.out("uno_1", "a\n");
    s.out("c3_2", "b\n");
    const run = s.run;
    s.clear("uno_1");
    expect(s.entries("uno_1")).toEqual([]);
    expect(s.entries("c3_2")).toEqual([{ kind: "out", text: "b\n" }]);
    expect(s.run).toBe(run);
    s.reset([{ name: "uno_1", ref: "U1" }]);
    expect(s.run).toBe(run + 1);
    expect(s.chips).toEqual([{ name: "uno_1", ref: "U1" }]);
    expect(s.entries("c3_2")).toEqual([]);
    expect(s.printed).toBe(false);
  });

  it("a carriage return held back from one run is not the start of the next", () => {
    const { s } = store();
    s.out("uno_1", "end\r");
    s.reset([{ name: "uno_1", ref: "U1" }]);
    s.out("uno_1", "new");
    expect(s.entries("uno_1")).toEqual([{ kind: "out", text: "new" }]);
  });

  it("tell who listens about every change, and count them", async () => {
    const { s } = store();
    const heard = vi.fn();
    const off = s.onChange(heard);
    const before = s.stamp;
    s.out("uno_1", "a");
    s.note("uno_1", "b");
    await s.send("uno_1", "c\n");
    s.clear("uno_1");
    s.touch();
    expect(heard).toHaveBeenCalledTimes(5);
    expect(s.stamp).toBe(before + 5);
    // nothing new: nobody is told
    s.out("uno_1", "");
    s.clear("uno_1");
    expect(heard).toHaveBeenCalledTimes(5);
    off();
    s.out("uno_1", "d");
    expect(heard).toHaveBeenCalledTimes(5);
  });

  it("a listener that throws does not stop the others", () => {
    const { s } = store();
    const second = vi.fn();
    s.onChange(() => {
      throw new Error("no");
    });
    s.onChange(second);
    s.out("uno_1", "a");
    expect(second).toHaveBeenCalledTimes(1);
  });
});
