import { describe, expect, it } from "vitest";
import { errorMessage, isTerminalError, isTerminalSerializedError } from "./terminal-error";

/**
 * The strings below are the REAL ones observed on editor.pcbjam.com — a wedged
 * pcbnew session where every key/focus/resize event re-entered dead wasm. The
 * previous inline regex matched none of them, which is why the fatal overlay
 * never appeared.
 */
describe("isTerminalError", () => {
  it("matches a WebAssembly.RuntimeError by type, whatever the message says", () => {
    // The type is the load-bearing signal: `.message` is just "unreachable",
    // which the old regex (looking for "unreachable executed") missed.
    expect(isTerminalError(new WebAssembly.RuntimeError("unreachable"), "unreachable")).toBe(true);
    expect(isTerminalError(new WebAssembly.RuntimeError("null function"), "null function")).toBe(
      true,
    );
    // Even a message we have no pattern for is terminal if the type says so.
    expect(isTerminalError(new WebAssembly.RuntimeError("something new"), "something new")).toBe(
      true,
    );
  });

  it("matches an Error named RuntimeError that crossed a realm boundary", () => {
    const err = new Error("unreachable");
    err.name = "RuntimeError";
    expect(isTerminalError(err, "unreachable")).toBe(true);
  });

  it("falls back to the message when the Error object is unavailable", () => {
    // Worker ErrorEvents arrive with `error: null` — message is all we get.
    expect(isTerminalError(null, "RuntimeError: unreachable")).toBe(true);
    expect(isTerminalError(null, "null function or function signature mismatch")).toBe(true);
    expect(isTerminalError(null, "table index is out of bounds")).toBe(true);
    expect(isTerminalError(null, "memory access out of bounds")).toBe(true);
    expect(isTerminalError(null, "indirect call signature mismatch")).toBe(true);
    expect(isTerminalError(null, "Aborted(RuntimeError: unreachable)")).toBe(true);
    expect(isTerminalError(null, "abort")).toBe(true);
  });

  it("does NOT match ordinary app errors — a working editor must not be hijacked", () => {
    expect(isTerminalError(new TypeError("x is not a function"), "x is not a function")).toBe(false);
    expect(isTerminalError(new Error("failed to fetch"), "failed to fetch")).toBe(false);
    expect(isTerminalError(null, "ResizeObserver loop completed with undelivered notifications"))
      .toBe(false);
    expect(isTerminalError(undefined, "")).toBe(false);
  });

  /**
   * Engine-spelling matrix. This predicate replaced a regex that was chasing
   * per-engine wording and losing: 197f317 added Firefox's forms and in doing so
   * narrowed "table index is out of bounds" to `\bindex out of bounds`, which
   * stopped matching Chrome's. Every row below is a real production spelling —
   * they must ALL hold, in both engines, message-only (no Error object).
   */
  it.each([
    ["unreachable", "Chrome — v0.1.20 prod"],
    ["null function", "Chrome — v0.1.20 prod"],
    ["null function or function signature mismatch", "Chrome — full form"],
    ["unreachable executed", "Chrome — older V8 wording"],
    ["index out of bounds", "Firefox — v0.1.19 prod, what 197f317 fixed"],
    ["table index is out of bounds", "Chrome — regressed by 197f317"],
    ["memory access out of bounds", "both"],
    ["indirect call signature mismatch", "both"],
  ])("matches the trap spelling %j (%s)", (msg) => {
    expect(isTerminalError(null, msg)).toBe(true);
  });

  it("does not match 'abort' inside an unrelated word", () => {
    // \b guards the alternative — "aborting" is fine, "collaborator" must not be.
    expect(isTerminalError(null, "collaborator joined")).toBe(false);
  });
});

/**
 * Regression: the reporter classifies from a SERIALIZED event, where the live
 * Error is gone. An earlier version fell back to the message alone there, so a
 * RuntimeError with unanticipated wording was treated as an ordinary error and
 * the cascade guard never armed — one wedged session then reported N times.
 * Caught by a real end-to-end test, not by the unit tests, hence this block.
 */
describe("isTerminalSerializedError", () => {
  it("trusts the serialized type even when the message matches nothing", () => {
    expect(isTerminalSerializedError("RuntimeError", "test from local")).toBe(true);
    expect(isTerminalSerializedError("RuntimeError", "some wording we never saw")).toBe(true);
  });

  it("still matches known wording when the type is absent or generic", () => {
    expect(isTerminalSerializedError(undefined, "unreachable")).toBe(true);
    expect(isTerminalSerializedError("Error", "null function")).toBe(true);
    expect(isTerminalSerializedError("Error", "memory access out of bounds")).toBe(true);
  });

  it("does not match ordinary serialized errors", () => {
    expect(isTerminalSerializedError("TypeError", "x is not a function")).toBe(false);
    expect(isTerminalSerializedError("Error", "failed to fetch")).toBe(false);
    expect(isTerminalSerializedError(undefined, "")).toBe(false);
  });
});

describe("errorMessage", () => {
  it("prefers the Error's message", () => {
    expect(errorMessage(new Error("boom"), "ignored")).toBe("boom");
  });

  it("stringifies a non-Error rejection reason", () => {
    expect(errorMessage("plain string reason")).toBe("plain string reason");
    expect(errorMessage(42)).toBe("42");
  });

  it("uses the fallback when there is no error value", () => {
    expect(errorMessage(null, "event.message")).toBe("event.message");
    expect(errorMessage(undefined)).toBe("");
  });
});
