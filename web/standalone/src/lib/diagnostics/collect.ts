import {
  PROBLEM_REPORT_LIMITS,
  type ProblemReportBody,
  type ProblemReportContext,
  type ProblemReportLogs,
  type ProblemReportNetworkEntry,
  type ProblemReportScreenshot,
} from "@pcbjam/shared";
import { API_BASE_URL, APP_GIT_SHA, APP_TAG } from "@/lib/config";
import { currentCopyId } from "@/lib/copy-context";
import { downloadBytes } from "@/lib/download";
import { errorEventIds, redact } from "@/lib/error-reporting";
import { memfsFilePath } from "@/wasm/constants";
import { fatalLogLines } from "@/wasm/fatal-screen";
import { dump as dumpTrace } from "@/wasm/load-trace";
import { consoleEntries, errorEntries } from "./console-buffer";
import { collectEnvironment } from "./environment";

/**
 * Assemble a problem report (problem-reports 0001) from everything the page
 * can tell: the user's words, the console and editor logs, uncaught errors,
 * failed requests, the environment, and which project and file were open.
 * Each section is trimmed to the shared caps here, so the server never has
 * to refuse a report for being large.
 */

/** What the editor knows about the open project; all optional (a crash can
 *  happen before most of it exists). */
export interface ReportProjectInfo {
  /** Scope slug (first URL segment). */
  scope: string;
  /** Project slug. */
  slug: string;
  projectId?: string;
  tool?: string;
  /** Project-relative path of the open document. */
  file?: string;
  files?: readonly { path: string }[];
  /** "remote-rw" | "remote-ro" | "local" (lib/project-source-shared.ts). */
  sourceKind?: string;
  readOnly?: boolean;
  peers?: number;
}

export interface BuildReportInput {
  description: string;
  projectConsent: boolean;
  project: ReportProjectInfo | null;
  screenshot: ProblemReportScreenshot | null;
}

/** Leave headroom under the server caps (its byte count is of the parsed body). */
const MARGIN = 0.95;

const encoder = new TextEncoder();
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").length;
}

/** The page URL with credentials scrubbed (`?token=` and the like). */
export function redactedUrl(href: string): string {
  return redact(href);
}

/** Requests that came back >= 400, newest last (resource timing). */
export function failedRequests(
  entries: readonly PerformanceEntry[] = typeof performance === "undefined" ? [] : performance.getEntriesByType("resource"),
): ProblemReportNetworkEntry[] {
  const origin = typeof performance === "undefined" ? 0 : performance.timeOrigin;
  const out: ProblemReportNetworkEntry[] = [];
  for (const e of entries) {
    const r = e as PerformanceResourceTiming & { responseStatus?: number };
    if (typeof r.responseStatus !== "number" || r.responseStatus < 400) continue;
    out.push({
      t: Math.round(origin + r.startTime),
      url: redact(r.name),
      status: r.responseStatus,
      durationMs: Math.round(r.duration),
      ...(r.initiatorType ? { initiator: r.initiatorType } : {}),
    });
  }
  return out.slice(-PROBLEM_REPORT_LIMITS.network);
}

/** Cap counts, then drop the oldest console entries (then editor lines, then
 *  the dumps) until the JSON fits `max` bytes. */
export function fitLogs(logs: ProblemReportLogs, max: number = PROBLEM_REPORT_LIMITS.logsBytes * MARGIN): ProblemReportLogs {
  const out: ProblemReportLogs = {
    ...logs,
    console: logs.console.slice(-PROBLEM_REPORT_LIMITS.consoleEntries),
    editor: logs.editor.slice(-PROBLEM_REPORT_LIMITS.editorLines),
    errors: logs.errors.slice(-PROBLEM_REPORT_LIMITS.errors),
    network: logs.network.slice(-PROBLEM_REPORT_LIMITS.network),
  };
  let size = jsonBytes(out);
  while (size > max && out.console.length > 0) size -= jsonBytes(out.console.shift()) + 1;
  while (size > max && out.editor.length > 0) size -= jsonBytes(out.editor.shift()) + 1;
  if (size > max) {
    delete out.wxWaitDump;
    delete out.loadTrace;
    out.errors = out.errors.slice(-10);
    out.network = out.network.slice(-10);
  }
  return out;
}

/** Cap the file list, then shed it and the free-form page keys if the
 *  context still does not fit. */
export function fitContext(context: ProblemReportContext, max: number = PROBLEM_REPORT_LIMITS.contextBytes * MARGIN): ProblemReportContext {
  const page = { ...context.page };
  if (Array.isArray(page.files) && page.files.length > PROBLEM_REPORT_LIMITS.files) {
    page.filesOmitted = page.files.length - PROBLEM_REPORT_LIMITS.files;
    page.files = page.files.slice(0, PROBLEM_REPORT_LIMITS.files);
  }
  let out: ProblemReportContext = { ...context, page };
  while (jsonBytes(out) > max && Array.isArray(out.page.files) && out.page.files.length > 0) {
    const files = out.page.files as unknown[];
    const keep = Math.floor(files.length / 2);
    out = { ...out, page: { ...out.page, files: files.slice(0, keep), filesOmitted: (Number(out.page.filesOmitted) || 0) + files.length - keep } };
  }
  if (jsonBytes(out) > max) {
    const env = { ...out.env };
    delete env.userAgentData;
    out = { ...out, env, page: { url: out.page.url, tool: out.page.tool, file: out.page.file } };
  }
  return out;
}

function fileSize(slug: string, path: string): number | undefined {
  try {
    const fs = (window as unknown as { FS?: { stat(p: string): { size: number } } }).FS;
    return fs?.stat(memfsFilePath(slug, path)).size;
  } catch {
    return undefined;
  }
}

function wxWaitDump(): string | undefined {
  try {
    const rec = (window as Window & { __wxWaitDump?: () => unknown }).__wxWaitDump?.();
    return rec ? JSON.stringify(rec) : undefined;
  } catch {
    return undefined;
  }
}

/** The page context: app build, environment, and what was open. */
async function collectContext(project: ReportProjectInfo | null, editorLog: readonly string[]): Promise<ProblemReportContext> {
  const env = await collectEnvironment();
  const app: Record<string, unknown> = {
    tag: APP_TAG ?? undefined,
    sha: APP_GIT_SHA ?? undefined,
    apiBase: API_BASE_URL || undefined,
    // The `[build]` provenance lines pin the exact wasm + frontend bundles.
    build: editorLog.filter((l) => l.startsWith("[build]")).slice(-4),
  };
  const page: Record<string, unknown> = {
    url: typeof location === "undefined" ? undefined : redactedUrl(location.href),
    copy: currentCopyId() ?? undefined,
    uptimeMs: typeof performance === "undefined" ? undefined : Math.round(performance.now()),
    visibility: typeof document === "undefined" ? undefined : document.visibilityState,
  };
  if (project) {
    Object.assign(page, {
      scope: project.scope,
      project: project.slug,
      projectId: project.projectId,
      tool: project.tool,
      file: project.file,
      sourceKind: project.sourceKind,
      readOnly: project.readOnly,
      peers: project.peers,
      fileCount: project.files?.length,
      files: project.files?.map((f) => ({ path: f.path, size: fileSize(project.slug, f.path) })),
    });
  }
  return fitContext({ app, env, page });
}

/** Snapshot the logs right now. */
export function collectLogs(editorLog: readonly string[] = fatalLogLines()): ProblemReportLogs {
  let loadTrace: string | undefined;
  try {
    loadTrace = dumpTrace();
  } catch {
    loadTrace = undefined;
  }
  return fitLogs({
    console: consoleEntries(),
    editor: editorLog.map(redact),
    errors: errorEntries(),
    network: failedRequests(),
    loadTrace,
    wxWaitDump: wxWaitDump(),
    errorEventIds: errorEventIds(),
  });
}

export async function buildProblemReport(input: BuildReportInput): Promise<ProblemReportBody> {
  const editorLog = fatalLogLines();
  const { project } = input;
  // Only backend projects are something the team could open: browser-local
  // ones and the demo gallery go out as context only, never with consent.
  const remote = project?.sourceKind === "remote-rw" ? project : null;
  return {
    description: input.description.trim().slice(0, PROBLEM_REPORT_LIMITS.descriptionChars),
    projectConsent: remote ? input.projectConsent : false,
    ...(remote
      ? {
          project: {
            scope: remote.scope,
            project: remote.slug,
            ...(remote.projectId ? { projectId: remote.projectId } : {}),
            ...(currentCopyId() ? { copy: currentCopyId()! } : {}),
            ...(remote.tool ? { tool: remote.tool } : {}),
            ...(remote.file ? { file: remote.file } : {}),
          },
        }
      : {}),
    context: await collectContext(project, editorLog),
    logs: collectLogs(editorLog),
    ...(input.screenshot ? { screenshot: input.screenshot } : {}),
  };
}

/** Last resort when sending fails: hand the user the report as a file. */
export function downloadProblemReport(body: ProblemReportBody): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadBytes(`pcbjam-problem-report-${stamp}.json`, encoder.encode(JSON.stringify(body, null, 2)));
}
