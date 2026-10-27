import { collectLogs, jsonBytes, type ReportProjectInfo } from "./collect";

/**
 * The words "Report a problem" shows, shared by the React dialog
 * (components/ReportProblemDialog.tsx) and the DOM crash floor's form
 * (floor-report.ts), so the two always promise the same thing.
 */

export const DESCRIPTION_LABEL = "What went wrong?";
export const DESCRIPTION_PLACEHOLDER = "What were you doing, what did you expect, and what happened instead?";
export const CONSENT_LABEL =
  "OK for the pcbjam team to open and edit this project to reproduce the problem " +
  "(until we close the report, at most 14 days)";
export const CONSENT_IGNORED = "Project access was not turned on: only members of the project's team can allow it.";

export const sentMessage = (shortId: string) => `Report #${shortId} sent. Thank you!`;

export const accessMessage = (until: string) =>
  `The pcbjam team can open this project until ${new Date(until).toLocaleDateString(undefined, { dateStyle: "medium" })}.`;

const kb = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The "What we send" lines, from a snapshot of the logs taken now. */
export function reportSummaryLines(project: ReportProjectInfo | null): string[] {
  const logs = collectLogs();
  const lines = [
    "What you write above",
    "Browser, operating system, graphics and memory details",
    "App and editor versions",
    `Console and editor logs (${logs.console.length} + ${logs.editor.length} lines, about ${kb(jsonBytes(logs))})`,
    `${logs.errors.length} uncaught error(s) and ${logs.network.length} failed request(s)`,
  ];
  if (project) {
    lines.push(
      `Which project and file were open (${project.slug}${project.file ? `, ${project.file}` : ""}; ` +
        `${project.files?.length ?? 0} file names and sizes, not their contents)`,
    );
  }
  return lines;
}

export const screenshotLine = (bytes: number) => `Screenshot (about ${kb(bytes)})`;
