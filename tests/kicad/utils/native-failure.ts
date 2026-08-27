export type RuntimeLogger = { consoleLogs: string[]; errors: string[] };

/**
 * The one shared list of fatal wasm-runtime console signatures. Before this
 * module, three divergent copies existed (trio.ts hasAbort: `Aborted(` only;
 * board-ready.ts: + `RuntimeError: unreachable` + `memory access out of
 * bounds`; spec-local variants: + `index out of bounds` etc.) — so whether a
 * native crash failed a spec fast or burned its full timeout depended on
 * which helper the spec happened to call. Add new engine wordings HERE.
 */
export const FATAL_WASM_PATTERNS = [
    'Aborted(',
    'RuntimeError: unreachable',
    'memory access out of bounds',
    'index out of bounds',
    'indirect call to null',
    'uncaught exception: unwind',
] as const;

/** First captured console/error line matching a fatal wasm signature, if any. */
export function findNativeFailure(lines: readonly string[]): string | undefined {
    return lines.find((line) => FATAL_WASM_PATTERNS.some((p) => line.includes(p)));
}

/** Whether the logger has captured any fatal wasm signature. */
export function hasNativeFailure(logger: RuntimeLogger): boolean {
    return findNativeFailure([...logger.consoleLogs, ...logger.errors]) !== undefined;
}

/** Throw (with the offending line) if the logger captured a fatal wasm signature. */
export function assertNoNativeFailure(logger: RuntimeLogger | undefined, phase: string): void {
    if (!logger) return;
    const failure = findNativeFailure([...logger.consoleLogs, ...logger.errors]);
    if (failure) throw new Error(`WASM failed during ${phase}:\n${failure}`);
}
