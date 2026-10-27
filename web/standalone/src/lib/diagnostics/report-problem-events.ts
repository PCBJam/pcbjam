import type { ReportProjectInfo } from "./collect";

/**
 * Opening "Report a problem" from anywhere (session menu, crash screen):
 * entry points dispatch this event, and the one ReportProblemHost mounted in
 * the editor listens. Kept free of React so any module can call it.
 */
export const REPORT_PROBLEM_EVENT = "pcbjam:report-problem";

export function openReportProblem(): void {
  window.dispatchEvent(new CustomEvent(REPORT_PROBLEM_EVENT));
}

/** What the open session lets a report say about the project. */
export interface ReportProblemContext {
  project: ReportProjectInfo | null;
  /** A backend project this session may edit: only then can the user let the team in. */
  consentAllowed: boolean;
}

let context: ReportProblemContext = { project: null, consentAllowed: false };

/**
 * ReportProblemHost keeps this current, so the DOM crash floor
 * (wasm/fatal-screen.ts) can still send a full report after React died.
 */
export function setReportProblemContext(next: ReportProblemContext): void {
  context = next;
}

export function reportProblemContext(): ReportProblemContext {
  return context;
}
