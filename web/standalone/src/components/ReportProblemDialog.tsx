import * as React from "react";
import { PROBLEM_REPORT_LIMITS, type ProblemReportBody, type ProblemReportCreated } from "@pcbjam/shared";
import { ChevronDown, ChevronRight, Download, Loader2 } from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from "@pcbjam/ui";
import { createProblemReport } from "@/lib/api";
import { buildProblemReport, downloadProblemReport, type ReportProjectInfo } from "@/lib/diagnostics/collect";
import {
  accessMessage,
  CONSENT_IGNORED,
  CONSENT_LABEL,
  DESCRIPTION_LABEL,
  DESCRIPTION_PLACEHOLDER,
  reportSummaryLines,
  screenshotLine,
  sentMessage,
} from "@/lib/diagnostics/report-copy";
import { REPORT_PROBLEM_EVENT, setReportProblemContext } from "@/lib/diagnostics/report-problem-events";
import { captureScreenshot, releaseScreenshot, type CapturedScreenshot } from "@/lib/diagnostics/screenshot";

/**
 * "Report a problem" (problem-reports 0001). The host listens for
 * `openReportProblem()`, takes the screenshot while the page still shows the
 * problem, then opens the dialog: the user's own words, the screenshot to
 * keep or drop, and (for backend projects they can edit) consent for the team
 * to open and edit the project. Logs and system details are gathered at send
 * time, so they include everything up to the click.
 */

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function ReportProblemHost({
  project,
  consentAllowed,
}: {
  project: ReportProjectInfo | null;
  /** A backend project this session may edit: only then can the user let the team in. */
  consentAllowed: boolean;
}) {
  const [shot, setShot] = React.useState<CapturedScreenshot | null>(null);
  const [open, setOpen] = React.useState(false);
  const busy = React.useRef(false);

  // For the DOM crash floor's form, which outlives this component.
  React.useEffect(() => setReportProblemContext({ project, consentAllowed }), [project, consentAllowed]);

  React.useEffect(() => {
    const onOpen = async () => {
      if (busy.current) return;
      busy.current = true;
      const cursor = document.body.style.cursor;
      document.body.style.cursor = "progress";
      try {
        // Two frames: the menu that launched this has closed before the capture.
        await nextFrame();
        await nextFrame();
        setShot(await captureScreenshot());
        setOpen(true);
      } catch {
        busy.current = false;
      } finally {
        document.body.style.cursor = cursor;
      }
    };
    window.addEventListener(REPORT_PROBLEM_EVENT, onOpen);
    return () => window.removeEventListener(REPORT_PROBLEM_EVENT, onOpen);
  }, []);

  if (!open) return null;
  return (
    <ReportProblemDialog
      project={project}
      consentAllowed={consentAllowed}
      shot={shot}
      onClose={() => {
        releaseScreenshot(shot);
        setShot(null);
        setOpen(false);
        busy.current = false;
      }}
    />
  );
}

/** The "What we send" lines, from a snapshot taken when the dialog opens. */
function summarize(project: ReportProjectInfo | null, shot: CapturedScreenshot | null): { sendList: string[]; shotLine: string | null } {
  return { sendList: reportSummaryLines(project), shotLine: shot ? screenshotLine(shot.bytes) : null };
}

function ReportProblemDialog({
  project,
  consentAllowed,
  shot,
  onClose,
}: {
  project: ReportProjectInfo | null;
  consentAllowed: boolean;
  shot: CapturedScreenshot | null;
  onClose: () => void;
}) {
  const [description, setDescription] = React.useState("");
  const [includeShot, setIncludeShot] = React.useState(shot !== null);
  const [consent, setConsent] = React.useState(false);
  const [showDetails, setShowDetails] = React.useState(false);
  const [phase, setPhase] = React.useState<"edit" | "sending" | "sent" | "failed">("edit");
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ProblemReportCreated | null>(null);
  const lastBody = React.useRef<ProblemReportBody | null>(null);
  // Once, at open: WasmTool re-renders on every log line.
  const [summary] = React.useState(() => summarize(project, shot));
  const limit = PROBLEM_REPORT_LIMITS.descriptionChars;
  const askedConsent = consentAllowed && consent;

  const send = async () => {
    setPhase("sending");
    setError(null);
    try {
      const body = await buildProblemReport({
        description,
        projectConsent: askedConsent,
        project,
        screenshot: includeShot && shot ? { mime: shot.mime, base64: shot.base64 } : null,
      });
      lastBody.current = body;
      setResult(await createProblemReport(body));
      setPhase("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("failed");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && phase !== "sending") onClose();
      }}
    >
      <DialogContent data-testid="report-problem-dialog" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription>
            Tell us what went wrong in your own words. We attach logs and system details so we can
            reproduce it.
          </DialogDescription>
        </DialogHeader>

        {phase === "sent" && result ? (
          <div className="space-y-2 text-sm">
            <p data-testid="report-problem-sent">{sentMessage(result.shortId)}</p>
            {result.supportAccessUntil ? (
              <p className="text-muted-foreground" data-testid="report-problem-access">
                {accessMessage(result.supportAccessUntil)}
              </p>
            ) : (
              askedConsent && <p className="text-muted-foreground">{CONSENT_IGNORED}</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="report-problem-description">{DESCRIPTION_LABEL}</Label>
              <Textarea
                id="report-problem-description"
                data-testid="report-problem-description"
                className="min-h-28"
                placeholder={DESCRIPTION_PLACEHOLDER}
                maxLength={limit}
                value={description}
                disabled={phase === "sending"}
                onChange={(e) => setDescription(e.target.value)}
                autoFocus
              />
              {description.length > limit * 0.8 && (
                <p className="text-right text-xs text-muted-foreground">
                  {description.length}/{limit}
                </p>
              )}
            </div>

            {shot && (
              <div className="space-y-2">
                <a href={shot.blobUrl} target="_blank" rel="noreferrer" title="Open the screenshot full size">
                  <img
                    src={shot.blobUrl}
                    alt="Screenshot of the editor"
                    data-testid="report-problem-screenshot"
                    className={`max-h-40 rounded border ${includeShot ? "" : "opacity-40"}`}
                  />
                </a>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="report-problem-include-screenshot"
                    data-testid="report-problem-include-screenshot"
                    checked={includeShot}
                    disabled={phase === "sending"}
                    onCheckedChange={(v) => setIncludeShot(v === true)}
                  />
                  <Label htmlFor="report-problem-include-screenshot" className="font-normal">
                    Include screenshot
                  </Label>
                </div>
              </div>
            )}

            {consentAllowed && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="report-problem-consent"
                  data-testid="report-problem-consent"
                  className="mt-0.5"
                  checked={consent}
                  disabled={phase === "sending"}
                  onCheckedChange={(v) => setConsent(v === true)}
                />
                <Label htmlFor="report-problem-consent" className="font-normal leading-snug">
                  {CONSENT_LABEL}
                </Label>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              <Button
                variant="link"
                size="text"
                data-testid="report-problem-details-toggle"
                onClick={() => setShowDetails((v) => !v)}
              >
                {showDetails ? <ChevronDown /> : <ChevronRight />}
                What we send
              </Button>
              {showDetails && (
                <ul className="ml-5 mt-1 list-disc space-y-0.5" data-testid="report-problem-details">
                  {summary.sendList.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                  {includeShot && summary.shotLine && <li>{summary.shotLine}</li>}
                </ul>
              )}
            </div>

            {phase === "failed" && error && (
              <p className="text-sm text-destructive" data-testid="report-problem-error">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {phase === "sent" ? (
            <Button onClick={onClose}>Close</Button>
          ) : (
            <>
              {phase === "failed" && lastBody.current && (
                <Button
                  variant="outline"
                  data-testid="report-problem-download"
                  onClick={() => downloadProblemReport(lastBody.current!)}
                >
                  <Download /> Download report
                </Button>
              )}
              <Button variant="outline" disabled={phase === "sending"} onClick={onClose}>
                Cancel
              </Button>
              <Button
                data-testid="report-problem-send"
                disabled={phase === "sending" || description.trim().length === 0}
                onClick={() => void send()}
              >
                {phase === "sending" && <Loader2 className="animate-spin" />}
                {phase === "failed" ? "Try again" : "Send report"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
