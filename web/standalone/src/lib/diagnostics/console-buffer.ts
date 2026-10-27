import {
  PROBLEM_REPORT_LIMITS,
  type ProblemReportConsoleEntry,
  type ProblemReportErrorEntry,
  type ProblemReportLogLevel,
} from "@pcbjam/shared";
import { redact } from "@/lib/error-reporting";

/**
 * The page's console, kept for "Report a problem" (problem-reports 0001).
 *
 * Nothing else records console output: the error reporter drops console
 * breadcrumbs on purpose, and the editor's own log only has what WasmTool
 * `append`s. Installed first thing in main.tsx so boot chatter is in it too.
 * The originals still run, so devtools sees exactly what it saw before.
 *
 * Two bounded rings: console calls (count + text budget, oldest dropped
 * first) and uncaught errors / unhandled rejections. Every text is redacted
 * (`?token=`, Bearer) at capture time, so nothing secret sits in memory
 * waiting for a report.
 */

const LEVELS: readonly ProblemReportLogLevel[] = ["debug", "log", "info", "warn", "error"];

/** Total text the console ring may hold; a report trims further to its cap. */
export const CONSOLE_TEXT_BUDGET = 1_500_000;
/** Per-argument cap: one huge object must not evict the whole ring. */
export const MAX_ARG_CHARS = 2048;
const MAX_DEPTH = 3;
const MAX_KEYS = 50;

type ConsoleLike = Pick<Console, ProblemReportLogLevel>;

let consoleRing: ProblemReportConsoleEntry[] = [];
let consoleChars = 0;
let errorRing: ProblemReportErrorEntry[] = [];
let installed = false;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... [${text.length - max} more chars]` : text;
}

function describe(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type === "string") return depth === 0 ? (value as string) : JSON.stringify(value);
  if (type === "number" || type === "boolean" || type === "bigint") return String(value);
  if (type === "symbol") return (value as symbol).toString();
  if (type === "function") return `[function ${(value as { name?: string }).name || "anonymous"}]`;
  const obj = value as object;
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`;
    return value.stack ? (value.stack.includes(value.message) ? value.stack : `${head}\n${value.stack}`) : head;
  }
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength}B]`;
  if (ArrayBuffer.isView(value)) return `[${obj.constructor?.name ?? "TypedArray"} ${value.byteLength}B]`;
  if (typeof Element !== "undefined" && value instanceof Element) {
    return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}>`;
  }
  if (seen.has(obj)) return "[circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_KEYS).map((v) => describe(v, depth + 1, seen));
      if (value.length > MAX_KEYS) items.push(`... ${value.length - MAX_KEYS} more`);
      return `[${items.join(", ")}]`;
    }
    if (value instanceof Map) {
      const items = [...value.entries()]
        .slice(0, MAX_KEYS)
        .map(([k, v]) => `${describe(k, depth + 1, seen)} => ${describe(v, depth + 1, seen)}`);
      return `Map(${value.size}) {${items.join(", ")}}`;
    }
    if (value instanceof Set) {
      const items = [...value.values()].slice(0, MAX_KEYS).map((v) => describe(v, depth + 1, seen));
      return `Set(${value.size}) {${items.join(", ")}}`;
    }
    const keys = Object.keys(obj);
    const items = keys
      .slice(0, MAX_KEYS)
      .map((k) => `${k}: ${describe((obj as Record<string, unknown>)[k], depth + 1, seen)}`);
    if (keys.length > MAX_KEYS) items.push(`... ${keys.length - MAX_KEYS} more`);
    const name = obj.constructor && obj.constructor !== Object ? `${obj.constructor.name} ` : "";
    return `${name}{${items.join(", ")}}`;
  } catch {
    return "[unreadable]";
  } finally {
    seen.delete(obj);
  }
}

/** One console argument as text: never throws, capped at MAX_ARG_CHARS. */
export function formatArg(value: unknown): string {
  try {
    return clip(describe(value, 0, new WeakSet()), MAX_ARG_CHARS);
  } catch {
    return "[unreadable]";
  }
}

/**
 * Drop `%c` styling from a format string and the CSS argument each one
 * consumes (the collab logs color their prefix), so the report reads as text.
 */
function unstyle(args: readonly unknown[]): readonly unknown[] {
  const [first, ...rest] = args;
  if (typeof first !== "string" || !first.includes("%c")) return args;
  const styles = first.split("%c").length - 1;
  return [first.replaceAll("%c", ""), ...rest.slice(styles)];
}

/** Record one console call (exported for the worker bridges and tests). */
export function recordConsole(level: ProblemReportLogLevel, args: readonly unknown[], source?: string): void {
  const text = redact(unstyle(args).map(formatArg).join(" "));
  const entry: ProblemReportConsoleEntry = source ? { t: Date.now(), level, text, source } : { t: Date.now(), level, text };
  consoleRing.push(entry);
  consoleChars += text.length;
  while (
    consoleRing.length > PROBLEM_REPORT_LIMITS.consoleEntries ||
    (consoleChars > CONSOLE_TEXT_BUDGET && consoleRing.length > 1)
  ) {
    consoleChars -= consoleRing.shift()!.text.length;
  }
}

function recordError(entry: Omit<ProblemReportErrorEntry, "t">): void {
  errorRing.push({
    t: Date.now(),
    ...entry,
    message: redact(clip(entry.message, MAX_ARG_CHARS)),
    ...(entry.stack ? { stack: redact(clip(entry.stack, 8 * MAX_ARG_CHARS)) } : {}),
  });
  if (errorRing.length > PROBLEM_REPORT_LIMITS.errors) errorRing.shift();
}

function onError(e: Event): void {
  const ev = e as ErrorEvent;
  const err = ev.error as { stack?: unknown } | undefined;
  const where = ev.filename ? `${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : undefined;
  recordError({
    kind: "error",
    message: ev.message || (ev.error !== undefined ? formatArg(ev.error) : "error event"),
    ...(typeof err?.stack === "string" ? { stack: err.stack } : {}),
    ...(where ? { where } : {}),
  });
}

function onRejection(e: Event): void {
  const reason = (e as PromiseRejectionEvent).reason as { message?: unknown; stack?: unknown } | undefined;
  recordError({
    kind: "unhandledrejection",
    message: typeof reason?.message === "string" ? reason.message : formatArg(reason),
    ...(typeof reason?.stack === "string" ? { stack: reason.stack } : {}),
  });
}

/**
 * Start capturing. Idempotent. `con` / `target` are test seams: the defaults
 * are the global console and window.
 */
export function installConsoleBuffer(
  con: ConsoleLike = console,
  target: Pick<EventTarget, "addEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
): void {
  if (installed) return;
  installed = true;
  for (const level of LEVELS) {
    const original = con[level];
    if (typeof original !== "function") continue;
    con[level] = function (this: unknown, ...args: unknown[]) {
      try {
        recordConsole(level, args);
      } catch {
        /* capture must never break logging */
      }
      return original.apply(this, args);
    } as Console[typeof level];
  }
  // Capture phase: runs even when a later listener stops propagation.
  target?.addEventListener("error", onError, true);
  target?.addEventListener("unhandledrejection", onRejection, true);
}

export function consoleEntries(): ProblemReportConsoleEntry[] {
  return [...consoleRing];
}

export function errorEntries(): ProblemReportErrorEntry[] {
  return [...errorRing];
}

/** Test seam: empty the rings and allow a fresh install. */
export function resetConsoleBuffer(): void {
  consoleRing = [];
  consoleChars = 0;
  errorRing = [];
  installed = false;
}
