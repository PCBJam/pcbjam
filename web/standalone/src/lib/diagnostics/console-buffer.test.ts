import { PROBLEM_REPORT_LIMITS } from "@pcbjam/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONSOLE_TEXT_BUDGET,
  MAX_ARG_CHARS,
  consoleEntries,
  errorEntries,
  formatArg,
  installConsoleBuffer,
  recordConsole,
  resetConsoleBuffer,
} from "./console-buffer";

type Calls = Record<"debug" | "log" | "info" | "warn" | "error", unknown[][]>;

function fakeConsole() {
  const calls: Calls = { debug: [], log: [], info: [], warn: [], error: [] };
  const con = {
    debug: (...a: unknown[]) => void calls.debug.push(a),
    log: (...a: unknown[]) => void calls.log.push(a),
    info: (...a: unknown[]) => void calls.info.push(a),
    warn: (...a: unknown[]) => void calls.warn.push(a),
    error: (...a: unknown[]) => void calls.error.push(a),
  };
  return { con: con as unknown as Console, calls };
}

beforeEach(() => resetConsoleBuffer());
afterEach(() => resetConsoleBuffer());

describe("installConsoleBuffer", () => {
  it("records every level and still calls the originals", () => {
    const { con, calls } = fakeConsole();
    installConsoleBuffer(con, new EventTarget());
    con.log("hello", 1, true);
    con.warn("careful");
    con.error(new Error("boom"));
    expect(calls.log).toEqual([["hello", 1, true]]);
    expect(calls.warn).toEqual([["careful"]]);
    const entries = consoleEntries();
    expect(entries.map((e) => [e.level, e.text.split("\n")[0]])).toEqual([
      ["log", "hello 1 true"],
      ["warn", "careful"],
      ["error", "Error: boom"],
    ]);
  });

  it("is idempotent: a second install does not double-record", () => {
    const { con } = fakeConsole();
    installConsoleBuffer(con, new EventTarget());
    installConsoleBuffer(con, new EventTarget());
    con.info("once");
    expect(consoleEntries()).toHaveLength(1);
  });

  it("captures uncaught errors and unhandled rejections", () => {
    const target = new EventTarget();
    installConsoleBuffer(fakeConsole().con, target);
    const err = new Error("kaput");
    target.dispatchEvent(
      Object.assign(new Event("error"), { message: "Uncaught Error: kaput", error: err, filename: "app.js", lineno: 3, colno: 9 }),
    );
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new TypeError("nope") }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "plain string" }));
    const [first, second, third] = errorEntries();
    expect(first).toMatchObject({ kind: "error", message: "Uncaught Error: kaput", where: "app.js:3:9" });
    expect(first?.stack).toContain("kaput");
    expect(second).toMatchObject({ kind: "unhandledrejection", message: "nope" });
    expect(third).toMatchObject({ kind: "unhandledrejection", message: "plain string" });
  });

  it("keeps at most the error cap", () => {
    const target = new EventTarget();
    installConsoleBuffer(fakeConsole().con, target);
    for (let i = 0; i < PROBLEM_REPORT_LIMITS.errors + 5; i++) {
      target.dispatchEvent(Object.assign(new Event("error"), { message: `e${i}` }));
    }
    const errors = errorEntries();
    expect(errors).toHaveLength(PROBLEM_REPORT_LIMITS.errors);
    expect(errors[0]?.message).toBe("e5");
  });
});

describe("the console ring", () => {
  it("drops the oldest entries past the count cap", () => {
    for (let i = 0; i < PROBLEM_REPORT_LIMITS.consoleEntries + 10; i++) recordConsole("log", [`line ${i}`]);
    const entries = consoleEntries();
    expect(entries).toHaveLength(PROBLEM_REPORT_LIMITS.consoleEntries);
    expect(entries[0]?.text).toBe("line 10");
  });

  it("drops the oldest entries past the text budget", () => {
    const big = "x".repeat(MAX_ARG_CHARS - 100);
    const n = Math.ceil(CONSOLE_TEXT_BUDGET / big.length) + 20;
    for (let i = 0; i < n; i++) recordConsole("log", [big]);
    const total = consoleEntries().reduce((sum, e) => sum + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(CONSOLE_TEXT_BUDGET);
    expect(consoleEntries().length).toBeLessThan(n);
  });

  it("redacts credentials", () => {
    recordConsole("warn", ["ws failed wss://x/room?token=abc123&doc=1", "Authorization: Bearer s3cr3t.tok"]);
    const text = consoleEntries()[0]?.text ?? "";
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("s3cr3t");
    expect(text).toContain("token=[redacted]");
  });

  it("tags entries from another source", () => {
    recordConsole("error", ["oops"], "occ-worker");
    expect(consoleEntries()[0]).toMatchObject({ level: "error", text: "oops", source: "occ-worker" });
  });

  it("drops %c styling and the CSS it consumes", () => {
    recordConsole("log", ["%c[collab]%c connected", "color:#0bd", "color:inherit", "peers", 2]);
    expect(consoleEntries()[0]?.text).toBe("[collab] connected peers 2");
  });
});

describe("formatArg", () => {
  it("handles cycles without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(formatArg(a)).toBe("{name: \"a\", self: [circular]}");
  });

  it("limits depth", () => {
    expect(formatArg({ a: { b: { c: { d: 1 } } } })).toBe("{a: {b: {c: [Object]}}}");
  });

  it("summarizes binary data", () => {
    expect(formatArg(new Uint8Array(10))).toBe("[Uint8Array 10B]");
    expect(formatArg(new ArrayBuffer(4))).toBe("[ArrayBuffer 4B]");
  });

  it("caps one argument's length", () => {
    const out = formatArg("y".repeat(MAX_ARG_CHARS * 2));
    expect(out.length).toBeLessThan(MAX_ARG_CHARS + 40);
    expect(out).toContain("more chars");
  });

  it("formats errors with their stack, and odd values", () => {
    const err = new RangeError("bad");
    expect(formatArg(err)).toContain("RangeError: bad");
    expect(formatArg(undefined)).toBe("undefined");
    expect(formatArg(null)).toBe("null");
    expect(formatArg(function named() {})).toBe("[function named]");
    expect(formatArg(new Map([["k", 1]]))).toBe("Map(1) {\"k\" => 1}");
  });

  it("survives getters that throw", () => {
    const evil = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("no");
      },
    });
    expect(formatArg(evil)).toBe("[unreadable]");
  });
});
