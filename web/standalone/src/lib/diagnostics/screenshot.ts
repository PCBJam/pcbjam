import { PROBLEM_REPORT_LIMITS, type ProblemReportScreenshot } from "@pcbjam/shared";
import { domToCanvas } from "modern-screenshot";
import { compositeCanvases, viewportScale } from "./canvas-composite";

/**
 * The screenshot for a problem report (problem-reports 0001), taken before
 * the dialog opens so it shows what the user was looking at.
 *
 * First choice: render the whole DOM (wx menus and toolbars are DOM, and
 * canvases are copied in) with modern-screenshot. If that fails or takes
 * too long, composite the visible canvases instead: the GAL canvas keeps
 * its drawing buffer (`preserveDrawingBuffer`) and every wx window paints a
 * 2D canvas, so the board and the panels still show, without DOM chrome.
 * Never throws; null means no screenshot.
 */

export interface CapturedScreenshot extends ProblemReportScreenshot {
  /** Object URL for the preview; revoke with `releaseScreenshot`. */
  blobUrl: string;
  width: number;
  height: number;
  bytes: number;
}

const TIMEOUT_MS = 5000;
/** Elements to leave out of the capture (e.g. a toast about the capture). */
export const SCREENSHOT_EXCLUDE_ATTR = "data-screenshot-exclude";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("screenshot timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function renderDom(): Promise<HTMLCanvasElement> {
  return domToCanvas(document.body, {
    width: window.innerWidth,
    height: window.innerHeight,
    scale: viewportScale(),
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
    timeout: TIMEOUT_MS,
    filter: (node) => !(node instanceof Element && node.hasAttribute(SCREENSHOT_EXCLUDE_ATTR)),
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function shrink(canvas: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(canvas.width * factor));
  out.height = Math.max(1, Math.round(canvas.height * factor));
  out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/** WebP where the browser can encode it (Safari can't: JPEG there), lowering
 *  quality, then size, until it fits the report's cap. */
async function encode(canvas: HTMLCanvasElement): Promise<{ blob: Blob; canvas: HTMLCanvasElement } | null> {
  let current = canvas;
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    let blob = await toBlob(current, "image/webp", quality);
    if (blob && blob.type !== "image/webp") blob = await toBlob(current, "image/jpeg", quality);
    if (!blob) return null;
    if (blob.size <= PROBLEM_REPORT_LIMITS.screenshotBytes) return { blob, canvas: current };
    if (quality <= 0.55) current = shrink(current, 0.7);
  }
  return null;
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function captureScreenshot(): Promise<CapturedScreenshot | null> {
  if (typeof document === "undefined") return null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = await withTimeout(renderDom(), TIMEOUT_MS);
  } catch (err) {
    console.warn("[report] DOM screenshot failed, compositing canvases:", err);
  }
  try {
    canvas ??= compositeCanvases();
  } catch (err) {
    console.warn("[report] canvas composite failed:", err);
  }
  return canvas ? screenshotFromCanvas(canvas) : null;
}

/** Encode an already captured frame (e.g. the crash floor's, taken at the crash). */
export async function screenshotFromCanvas(canvas: HTMLCanvasElement): Promise<CapturedScreenshot | null> {
  try {
    const encoded = await encode(canvas);
    if (!encoded) return null;
    const { blob } = encoded;
    return {
      mime: blob.type as ProblemReportScreenshot["mime"],
      base64: await base64Of(blob),
      blobUrl: URL.createObjectURL(blob),
      width: encoded.canvas.width,
      height: encoded.canvas.height,
      bytes: blob.size,
    };
  } catch (err) {
    console.warn("[report] screenshot unavailable:", err);
    return null;
  }
}

export function releaseScreenshot(shot: CapturedScreenshot | null): void {
  if (shot) URL.revokeObjectURL(shot.blobUrl);
}
