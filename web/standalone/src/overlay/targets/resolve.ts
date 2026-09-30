/**
 * Target resolvers: target id → page CSS rect, or null when not on screen.
 * Called from the tracker (never from render). The pure halves are exported
 * for unit tests; the DOM/registry reads stay thin.
 */
import { glCanvasRect, worldToCss, type CssRect } from "@/wasm/canvas-coords";
import type { ViewportState } from "@/wasm/collab/comments";
import { getViewport } from "@/wasm/viewport-store";
import type { ResolvedTarget } from "../types";
import { openDialog } from "../editor-events";
import { normalizeUiLabel, parseTarget, type ParsedTarget } from "./parse";
import { findDialogControl } from "./dialog-controls";
import { readBoardStatus } from "../board-status";
import { pickToolByAction, toolActionsFor } from "./tool-actions";

/** Registry coords are `#canvas`-relative (wxScreenBase in wx.js). */
export function wxRectToPage(
  entry: { screenX: number; screenY: number; width: number; height: number },
  origin: { x: number; y: number },
): CssRect {
  return { x: origin.x + entry.screenX, y: origin.y + entry.screenY, width: entry.width, height: entry.height };
}

/**
 * The toolbar tool whose tooltip's first line (hotkey stripped) or label is
 * `text`, on a toolbar window that is shown. First match wins; KiCad does
 * not repeat a tool across its visible toolbars.
 */
export function pickToolByText(
  tools: WxRenderedElementInfo[],
  windows: Map<string, WxElementInfo> | undefined,
  text: string,
): WxRenderedElementInfo | null {
  const want = normalizeUiLabel(text);
  for (const t of tools) {
    if (t.width <= 0 || t.height <= 0) continue;
    if (windows?.get(t.parentId)?.visible === false) continue;
    const label = normalizeUiLabel(t.label.replace(/ \[checked\]$/, ""));
    if (normalizeUiLabel(t.tooltip) === want || (label && label === want)) return t;
  }
  return null;
}

/** World rect → page rect via the viewport; null when fully off the canvas. */
export function worldRectToPage(
  vp: ViewportState,
  canvas: CssRect,
  r: { x: number; y: number; w: number; h: number },
): CssRect | null {
  const a = worldToCss(vp, canvas, { x: r.x, y: r.y });
  const b = worldToCss(vp, canvas, { x: r.x + r.w, y: r.y + r.h });
  if (!a || !b) return null;
  const rect = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
  const off =
    rect.x > canvas.x + canvas.width ||
    rect.y > canvas.y + canvas.height ||
    rect.x + rect.width < canvas.x ||
    rect.y + rect.height < canvas.y;
  return off ? null : rect;
}

function canvasOrigin(): { x: number; y: number } {
  const el = document.getElementById("canvas");
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top };
}

function domRect(el: Element | null): CssRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function resolveTooltip(text: string): ResolvedTarget | null {
  const reg = window.wxElementRegistry;
  const tools = reg?.findAllRendered?.({ elementType: "tool" }) ?? [];
  const hit = pickToolByText(tools, reg?.elements, text);
  return hit ? { rect: wxRectToPage(hit, canvasOrigin()), surface: "ui" } : null;
}

function resolveTool(action: string): ResolvedTarget | null {
  const reg = window.wxElementRegistry;
  const tools = reg?.findAllRendered?.({ elementType: "tool" }) ?? [];
  const actions = toolActionsFor(tools, reg?.renderedVersion ?? 0);
  const hit = pickToolByAction(tools, reg?.elements, actions, action);
  return hit ? { rect: wxRectToPage(hit, canvasOrigin()), surface: "ui" } : null;
}

function resolveDialog(cls: string, control?: { type: string; label?: string }): ResolvedTarget | null {
  const open = openDialog(cls);
  const reg = window.wxElementRegistry;
  const windows = reg?.elements;
  const win = open ? windows?.get(open.ptr) : undefined;
  if (!open || !windows || !win || !win.visible || win.width <= 0 || win.height <= 0) return null;
  if (!control) return { rect: wxRectToPage(win, canvasOrigin()), surface: "ui" };
  const hit = findDialogControl(open.ptr, control, windows, reg?.findAllRendered?.() ?? []);
  return hit ? { rect: wxRectToPage(hit, canvasOrigin()), surface: "ui" } : null;
}

/** `Module.kicadItemBBox(uuid)` → world rect; null when absent/off-sheet. */
export function parseItemBBox(raw: unknown): { x: number; y: number; w: number; h: number } | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const { x, y, w, h } = b;
    if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return { x: x as number, y: y as number, w: w as number, h: h as number };
  } catch {
    return null;
  }
}

function resolveItem(uuid: string): ResolvedTarget | null {
  const mod = (window as { Module?: { kicadItemBBox?: (id: string) => unknown } }).Module;
  const box = parseItemBBox(mod?.kicadItemBBox?.(uuid));
  return box ? resolveCanvas(box) : null;
}

/** `footprint:<REF>` → the footprint's box via the board read (PCB editor only). */
function resolveFootprint(ref: string): ResolvedTarget | null {
  const fp = readBoardStatus()?.footprints.find((f) => f.ref === ref);
  return fp ? resolveItem(fp.uuid) : null;
}

function resolveMenu(title: string, item: string | undefined): ResolvedTarget | null {
  if (item) {
    const want = normalizeUiLabel(item);
    const rows = document.querySelectorAll(".wx-menu-popup > div");
    for (const row of Array.from(rows)) {
      if (normalizeUiLabel(row.textContent ?? "") !== want) continue;
      const rect = domRect(row);
      if (rect) return { rect, surface: "ui" };
    }
    return null;
  }
  const want = normalizeUiLabel(title);
  for (const btn of Array.from(document.querySelectorAll(".wx-menu-title"))) {
    if (normalizeUiLabel(btn.textContent ?? "") !== want) continue;
    const rect = domRect(btn);
    if (rect) return { rect, surface: "ui" };
  }
  return null;
}

function resolvePanel(id: string): ResolvedTarget | null {
  const el = document.querySelector(`[data-overlay-target="${CSS.escape(id)}"]`);
  const rect = domRect(el);
  return rect ? { rect, surface: "ui" } : null;
}

function resolveCanvas(r: { x: number; y: number; w: number; h: number }): ResolvedTarget | null {
  const vp = getViewport();
  if (!vp) return null; // no viewport yet: no canvas to measure either
  const canvas = glCanvasRect();
  if (!canvas) return null;
  const rect = worldRectToPage(vp, canvas, r);
  return rect ? { rect, surface: "canvas" } : null;
}

export function resolveParsed(t: ParsedTarget): ResolvedTarget | null {
  switch (t.ns) {
    case "tool":
      return resolveTool(t.action);
    case "dialog":
      return resolveDialog(t.cls, t.control);
    case "item":
      return resolveItem(t.uuid);
    case "footprint":
      return resolveFootprint(t.ref);
    case "tooltip":
      return resolveTooltip(t.text);
    case "menu":
      return resolveMenu(t.title, t.item);
    case "panel":
      return resolvePanel(t.id);
    case "area":
      return resolveCanvas(t);
    case "point":
      return resolveCanvas({ x: t.x, y: t.y, w: 0, h: 0 });
  }
}

export function resolveTarget(target: string): ResolvedTarget | null {
  const parsed = parseTarget(target);
  return parsed ? resolveParsed(parsed) : null;
}

/** Which change signals can move this target (the tracker's dirty check). */
export function targetDependsOn(t: ParsedTarget): { registry: boolean; viewport: boolean; dom: boolean } {
  switch (t.ns) {
    case "tool":
    case "tooltip":
    case "dialog":
      return { registry: true, viewport: false, dom: false };
    case "area":
    case "point":
    case "item": // item moves without a viewport change are caught by the tracker's safety tick
    case "footprint":
      return { registry: false, viewport: true, dom: false };
    case "menu":
    case "panel":
      return { registry: false, viewport: false, dom: true };
  }
}
