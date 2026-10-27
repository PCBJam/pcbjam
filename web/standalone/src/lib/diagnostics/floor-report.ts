import { PROBLEM_REPORT_LIMITS, type ProblemReportBody } from "@pcbjam/shared";
import { createProblemReport } from "@/lib/api";
import { buildProblemReport, downloadProblemReport } from "./collect";
import {
  accessMessage,
  CONSENT_IGNORED,
  CONSENT_LABEL,
  DESCRIPTION_LABEL,
  DESCRIPTION_PLACEHOLDER,
  reportSummaryLines,
  screenshotLine,
  sentMessage,
} from "./report-copy";
import { crashFrame } from "@/wasm/fatal-screen";
import { reportProblemContext } from "./report-problem-events";
import { captureScreenshot, releaseScreenshot, SCREENSHOT_EXCLUDE_ATTR, screenshotFromCanvas } from "./screenshot";

/**
 * "Report a problem" on the DOM crash floor (wasm/fatal-screen.ts), for when
 * React itself died and took the dialog with it. Plain DOM and inline styles
 * like the floor, and loaded only when the user asks, so the floor stays as
 * small as it was. It sends the same report as the dialog (problem-reports
 * 0001), with the project and consent the dialog's host last saw.
 */

const BUTTON =
  "border:1px solid #ffffff66;background:transparent;color:#fff;border-radius:4px;" +
  "padding:4px 14px;font-size:12px;cursor:pointer;font-family:inherit;";
const PRIMARY = `${BUTTON}background:#fff;color:#1a1a2e;border-color:#fff;`;
const MUTED = "font-size:11px;color:#bfdbfe99;";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

function checkbox(testId: string, label: string): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = el("label", "display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.4;cursor:pointer;");
  const input = el("input", "margin-top:2px;");
  input.type = "checkbox";
  input.setAttribute("data-testid", testId);
  row.append(input, el("span", "", label));
  return { row, input };
}

function setEnabled(button: HTMLButtonElement, enabled: boolean): void {
  button.disabled = !enabled;
  button.style.opacity = enabled ? "1" : "0.5";
  button.style.cursor = enabled ? "pointer" : "default";
}

/**
 * Use the frame the floor kept from the moment of the crash (React has
 * usually taken the editor's DOM with it since), else a fresh screenshot
 * without the floor. Then build the form into `host`. Cancel removes it and
 * calls `onClose`.
 */
export async function openFloorReport(host: HTMLElement, floor: HTMLElement, onClose: () => void): Promise<void> {
  floor.setAttribute(SCREENSHOT_EXCLUDE_ATTR, "");
  const frame = crashFrame();
  const shot = (frame && (await screenshotFromCanvas(frame))) ?? (await captureScreenshot());
  const { project, consentAllowed } = reportProblemContext();

  const form = el("div", "width:100%;max-width:560px;display:flex;flex-direction:column;gap:10px;text-align:left;");
  form.setAttribute("data-testid", "fatal-report-form");

  const label = el("label", "font-size:12px;", DESCRIPTION_LABEL);
  const text = el(
    "textarea",
    "width:100%;box-sizing:border-box;min-height:96px;resize:vertical;padding:8px;border-radius:4px;" +
      "background:#00000059;color:#fff;border:1px solid #ffffff4d;font-family:inherit;font-size:12px;line-height:1.4;",
  );
  text.id = "fatal-report-description";
  text.setAttribute("data-testid", "fatal-report-description");
  text.placeholder = DESCRIPTION_PLACEHOLDER;
  text.maxLength = PROBLEM_REPORT_LIMITS.descriptionChars;
  label.htmlFor = text.id;
  form.append(label, text);

  let includeShot: HTMLInputElement | null = null;
  if (shot) {
    const row = el("div", "display:flex;gap:10px;align-items:center;");
    const img = el("img", "max-height:72px;max-width:128px;border:1px solid #ffffff4d;border-radius:3px;");
    img.src = shot.blobUrl;
    img.alt = "Screenshot of the page";
    img.setAttribute("data-testid", "fatal-report-screenshot");
    const box = checkbox("fatal-report-include-screenshot", "Include screenshot");
    box.input.checked = true;
    box.input.onchange = () => {
      img.style.opacity = box.input.checked ? "1" : "0.4";
    };
    includeShot = box.input;
    row.append(img, box.row);
    form.append(row);
  }

  let consent: HTMLInputElement | null = null;
  if (consentAllowed && project) {
    const box = checkbox("fatal-report-consent", CONSENT_LABEL);
    consent = box.input;
    form.append(box.row);
  }

  const details = el("details", MUTED);
  details.append(el("summary", "cursor:pointer;", "What we send"));
  const list = el("ul", "margin:4px 0 0 18px;padding:0;");
  for (const line of [...reportSummaryLines(project), ...(shot ? [screenshotLine(shot.bytes)] : [])]) {
    list.append(el("li", "", line));
  }
  details.append(list);

  const status = el("div", "font-size:12px;white-space:pre-wrap;");
  status.setAttribute("data-testid", "fatal-report-status");

  const buttons = el("div", "display:flex;gap:8px;justify-content:flex-end;");
  const download = el("button", BUTTON, "Download report");
  download.setAttribute("data-testid", "fatal-report-download");
  download.style.display = "none";
  const cancel = el("button", BUTTON, "Cancel");
  const send = el("button", PRIMARY, "Send report");
  send.setAttribute("data-testid", "fatal-report-send");
  buttons.append(download, cancel, send);
  form.append(details, status, buttons);

  let sending = false;
  let lastBody: ProblemReportBody | null = null;
  const sync = () => setEnabled(send, !sending && text.value.trim().length > 0);
  text.oninput = sync;
  sync();

  cancel.onclick = () => {
    releaseScreenshot(shot);
    form.remove();
    onClose();
  };
  download.onclick = () => {
    if (lastBody) downloadProblemReport(lastBody);
  };
  send.onclick = async () => {
    const askedConsent = consent?.checked === true;
    sending = true;
    sync();
    setEnabled(cancel, false);
    text.disabled = true;
    status.style.color = "#dbeafe";
    status.textContent = "Sending...";
    try {
      lastBody = await buildProblemReport({
        description: text.value,
        projectConsent: askedConsent,
        project,
        screenshot: includeShot?.checked && shot ? { mime: shot.mime, base64: shot.base64 } : null,
      });
      const result = await createProblemReport(lastBody);
      releaseScreenshot(shot);
      const done = el("div", "display:flex;flex-direction:column;gap:6px;font-size:12px;text-align:center;");
      const sent = el("div", "", sentMessage(result.shortId));
      sent.setAttribute("data-testid", "fatal-report-sent");
      done.append(sent);
      if (result.supportAccessUntil) done.append(el("div", MUTED, accessMessage(result.supportAccessUntil)));
      else if (askedConsent) done.append(el("div", MUTED, CONSENT_IGNORED));
      form.replaceChildren(done);
    } catch (err) {
      sending = false;
      status.style.color = "#fca5a5";
      status.textContent = err instanceof Error ? err.message : String(err);
      send.textContent = "Try again";
      download.style.display = lastBody ? "" : "none";
      text.disabled = false;
      setEnabled(cancel, true);
      sync();
    }
  };

  host.append(form);
  text.focus();
}
