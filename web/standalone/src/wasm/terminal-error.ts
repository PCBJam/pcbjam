/**
 * Is this error terminal — i.e. did the wasm instance just die?
 *
 * A wasm trap ("unreachable", "null function", "table index is out of bounds")
 * or an abort() leaves the module wedged: every later entry into wasm trips the
 * same fault, so the editor is unusable even though the page is still up. The
 * fatal overlay (components/WasmTool.tsx) and the error reporter both key off
 * this predicate, so they can never disagree about what "terminal" means.
 *
 * Why a TYPE check and not only a message match
 * ---------------------------------------------
 * This lived inline in WasmTool as a regex over `err.message`, and it silently
 * stopped matching. Two reasons, both instructive:
 *
 *   1. It listed `RuntimeError` as an alternative — but that is the error's
 *      *type*, which never appears in `.message`. `String(err)` would contain
 *      it; `err.message` does not.
 *   2. It listed `unreachable executed`, which was V8's old wording. Current
 *      Chrome throws `RuntimeError: unreachable`, and `null function` was never
 *      covered at all.
 *
 * Net effect in production: a wedged editor rendered a black canvas with no
 * overlay and no trace dump, which is exactly what the handler existed to
 * prevent. So the primary signal is now the type — `WebAssembly.RuntimeError`
 * is only ever thrown by a wasm trap — and the string patterns are a fallback
 * for the paths that surface a trap as a plain Error or a bare string (worker
 * `ErrorEvent`s cross the realm boundary with `error: null`, leaving only a
 * message).
 *
 * Widening to the type cannot "hijack a working editor" (the concern the
 * original guarded against): in this app a wasm trap always means the instance
 * is gone.
 */

/**
 * Message fragments that indicate a dead wasm instance, for the paths where the
 * Error object itself is unavailable. Kept deliberately narrow — an ordinary
 * app-level TypeError must not match, or the overlay would fire over a working
 * editor.
 */
const TERMINAL_MESSAGE =
  /\babort(ed)?\b|out of bounds|indirect call signature|null function|unreachable/i;

/**
 * @param err the caught value — `ErrorEvent.error`, `PromiseRejectionEvent.reason`,
 *            or whatever a catch block received. May be null/undefined.
 * @param msg the best available message string (callers pass `err.message` when
 *            `err` is an Error, else the event's own `message` field).
 */
export function isTerminalError(err: unknown, msg: string): boolean {
  // Primary signal: only a wasm trap produces one of these.
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) {
    return true;
  }
  // Same check by name, for realms where the instanceof fails (an error that
  // crossed a worker/iframe boundary carries a different intrinsic).
  if (err instanceof Error && err.name === "RuntimeError") return true;
  return TERMINAL_MESSAGE.test(msg);
}

/**
 * The same decision as `isTerminalError`, for an error that has already been
 * SERIALIZED and no longer exists as a live object — i.e. a reporter payload,
 * where the exception frame carries the constructor name and the message as two
 * plain strings.
 *
 * This exists because the object-based check above is unavailable there, and
 * falling back to the message alone reintroduces exactly the bug this module
 * was written to fix: a trap whose wording we didn't anticipate is silently
 * reclassified as an ordinary error. `type` is the serialized `err.name`, so
 * checking it is the faithful equivalent of the `instanceof` test.
 */
export function isTerminalSerializedError(
  type: string | undefined,
  value: string,
): boolean {
  if (type === "RuntimeError") return true;
  return TERMINAL_MESSAGE.test(value);
}

/**
 * Normalize a caught value to the message string `isTerminalError` expects.
 * Mirrors what the window handlers did inline, so both callers agree.
 */
export function errorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message;
  if (err != null) return String(err);
  return String(fallback ?? "");
}
