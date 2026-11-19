// Giving a chip its firmware from the page (live simulation).
//
// A chip of the simulation library runs a firmware that is a file of the project: an
// ESP32 its flash image (.bin), an Arduino board with an AVR chip its sketch as the
// Arduino IDE exports it (.hex). The chip's setting "firmware" names the file;
// chip-parts.ts reads it when Play is clicked. This file is the other direction: on the
// chip's line in the Simulation parts list the user picks a file from their computer. It
// is stored in the project under its own name, and that name is written onto the chip's
// symbol, in the field the settings live in, as one edit of the schematic: it can be
// undone and collaborators get it.
//
// The symbol is changed through the editor's own edit path (plugins/edits.ts), which
// takes the whole item as text. The text comes from the shared document of the shown
// sheet, so a chip on another sheet has to be opened first.
import type * as Y from "yjs";
import {
  MAX_FIRMWARE_UPLOAD_BYTES,
  firmwareKind,
  isFirmwareUploadPath,
  kicadItemsMap,
  parseSexpr,
  printSexpr,
  renderItem,
  yToItemUnchecked,
  type KicadItem,
  type SNode,
  type Slot,
} from "@pcbjam/shared";
import { FIELD_SETTINGS, formatSettings, parseSettings, resolveSettings, type PartManifest } from "@pcbjam/shared/sim-library";
import type { EditRequest } from "@/plugins/edits";
import { FIRMWARE_SETTING } from "./chip-parts";
import { imageProblem } from "./esp-image";
import { programProblem, readIntelHex } from "./intel-hex";
import type { SaveOutcome } from "./save-flow";
import type { SimParts } from "./sim-parts";

/** A placed chip that runs firmware, and the file it asks for. */
export interface ChipFirmware {
  /** The symbol's uuid. */
  uuid: string;
  ref: string;
  /** The file of the project the chip runs: the one its symbol names, else the part's own name for it. */
  name: string;
  /** Which chip the part is, as its emulator names it ("esp32c3"). Absent when the part does not say. */
  chip?: string;
}

/**
 * The chips of a read: every symbol that runs as a library part with an emulator, by the
 * symbol's uuid. The part's description is asked from the library (once per page).
 */
export async function chipFirmwares(parts: Pick<SimParts, "library" | "matches" | "symbols">): Promise<Map<string, ChipFirmware>> {
  const out = new Map<string, ChipFirmware>();
  for (const [i, match] of parts.matches.entries()) {
    const symbol = parts.symbols[i];
    if (match.status !== "matched" || !symbol || !parts.library.part(match.partId)?.emulator) continue;
    const manifest = JSON.parse(await parts.library.text(match.partId, "part.json")) as PartManifest;
    const name = resolveSettings(manifest, symbol).values[FIRMWARE_SETTING]?.value;
    const chip = manifest.digital?.kind === "emulator" ? manifest.digital.chip : undefined;
    if (name) out.set(symbol.uuid, { uuid: symbol.uuid, ref: match.ref, name, ...(chip ? { chip } : {}) });
  }
  return out;
}

// A setting's value is a plain token of at most this many characters (sim-library settings).
const NAME_MAX = 32;

/** How a firmware file's name ends: an ESP32's flash image, or an AVR chip's program as Intel HEX text. */
export type FirmwareExtension = ".bin" | ".hex";

/**
 * The ending of the file a chip runs. The chip's own file name says it: a part only takes
 * a name of its kind (the `accept` rule of its setting).
 */
export function firmwareExtension(chip: Pick<ChipFirmware, "name">): FirmwareExtension {
  return firmwareKind(chip.name) === "hex" ? ".hex" : ".bin";
}

/**
 * The name a picked file is kept under in the project: its own name, made a plain token
 * (letters, digits, "_", ".", "+", "-"), cut to what a setting can hold, ending the way
 * the chip's firmware does. Null when the file is not named like such a firmware.
 */
export function firmwareName(picked: string, ext: FirmwareExtension = ".bin"): string | null {
  const base = picked.split(/[\\/]/).pop() ?? "";
  if (!isFirmwareUploadPath(base) || !base.toLowerCase().endsWith(ext)) return null;
  const stem = base
    .slice(0, base.lastIndexOf("."))
    .replace(/[^A-Za-z0-9_.+-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, NAME_MAX - ext.length)
    .replace(/[-.]+$/, "");
  return `${stem || "firmware"}${ext}`;
}

/**
 * Why a file is not a firmware a project takes, in words, or null. The server asks the
 * same of its first bytes. With `chip` (what the part is, as its emulator names it) a
 * firmware built for another chip is not one either: it would be stored, and then not start.
 * The same for an image that holds the program alone (esp-image.ts). An image is judged
 * by its first bytes; a program (`.hex`) is read whole, so `head` is the file.
 */
export function firmwareProblem(size: number, head: Uint8Array, chip?: string, ext: FirmwareExtension = ".bin"): string | null {
  if (size > MAX_FIRMWARE_UPLOAD_BYTES) return `it is larger than ${MAX_FIRMWARE_UPLOAD_BYTES / (1024 * 1024)} MB, the most a firmware image can be`;
  if (ext === ".hex") {
    try {
      return programProblem(readIntelHex(new TextDecoder().decode(head)), chip);
    } catch (e) {
      const why = words(e);
      return /not an Intel HEX file/.test(why) ? `${why}. The file the Arduino IDE writes is needed: Sketch > Export Compiled Binary` : why;
    }
  }
  return imageProblem(head, chip);
}

function words(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const isQuoted = (atom: string): boolean => atom.length >= 2 && atom.startsWith('"') && atom.endsWith('"');
const ESCAPED: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
/** A string of KiCad's file text, as the characters it stands for. */
const unquote = (atom: string): string =>
  isQuoted(atom) ? atom.slice(1, -1).replace(/\\([\s\S])/g, (_, c: string) => ESCAPED[c] ?? c) : atom;
const quote = (text: string): string => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

type Field = [head: "property", name: string, ...rest: SNode[]];
const isField = (node: SNode): node is Field => Array.isArray(node) && node[0] === "property" && typeof node[1] === "string";
const says = (node: SNode, key: string): boolean => node === key || (Array.isArray(node) && node[0] === key && node[1] !== "no");
/** True for a field KiCad does not draw: "(hide yes)" on it or in its "(effects ...)". */
const isHidden = (field: SNode[]): boolean =>
  field.some((c) => says(c, "hide") || (Array.isArray(c) && c[0] === "effects" && c.some((e) => says(e, "hide"))));

/**
 * A placed symbol's text with its firmware setting set to `name`. The symbol's other
 * settings and everything else stay. A symbol that has no settings field yet gets one,
 * placed like one of its fields that is not drawn.
 */
export function withFirmware(symbol: string, name: string): string {
  const forms = parseSexpr(symbol);
  const node = forms[0];
  if (forms.length !== 1 || !Array.isArray(node) || node[0] !== "symbol") throw new Error("the item is not a symbol");
  const fields = node.filter(isField);
  const settings = fields.find((f) => unquote(f[1]) === FIELD_SETTINGS);
  if (settings) {
    const values = parseSettings(typeof settings[2] === "string" ? unquote(settings[2]) : "");
    values[FIRMWARE_SETTING] = name;
    settings[2] = quote(formatSettings(values));
    return printSexpr(node);
  }
  const last = fields[fields.length - 1];
  if (!last) throw new Error("the symbol has no fields");
  const like = [...fields].reverse().find(isHidden) ?? last;
  // an older file numbers its fields: the new one takes no number of another
  const made: SNode[] = ["property", quote(FIELD_SETTINGS), quote(formatSettings({ [FIRMWARE_SETTING]: name })),
    ...like.slice(3).filter((c) => !(Array.isArray(c) && c[0] === "id"))];
  if (!isHidden(made)) made.push(["hide", "yes"]);
  node.splice(node.indexOf(last) + 1, 0, made);
  return printSexpr(node);
}

/** A symbol of the shown sheet as KiCad's text, from the shared document. Null when the sheet does not have it. */
export function symbolText(doc: Y.Doc, uuid: string): string | null {
  const stored = kicadItemsMap(doc);
  const items: Record<string, KicadItem> = {};
  const take = (id: string): void => {
    const y = stored.get(id);
    if (!y || items[id]) return;
    const item = yToItemUnchecked(y);
    items[id] = item;
    walk(item.body);
  };
  const walk = (slots: Slot[]): void => {
    for (const slot of slots) {
      if ("item" in slot) take(slot.item);
      else if ("v" in slot) walk(slot.v);
    }
  };
  take(uuid);
  return items[uuid]?.type === "symbol" ? renderItem({ items }, uuid) : null;
}

export interface GiveFirmware {
  chip: ChipFirmware;
  /** The file the user picked. */
  file: Pick<File, "name" | "size" | "arrayBuffer">;
  /** The shared document of the shown sheet. Null in a session without one. */
  doc: Y.Doc | null;
  /** Stores a file in the project's top folder; a file of that name is replaced. */
  save: (relPath: string, bytes: Uint8Array) => Promise<SaveOutcome>;
  /** Changes items of the shown sheet as one step of the schematic's history. */
  edit: (request: EditRequest) => Promise<unknown>;
}

/**
 * Stores the picked file in the project and names it on the chip. Resolves with the name
 * the file is kept under. Rejects with a sentence for the user; nothing is stored when
 * the file is no firmware image or the chip's symbol cannot be reached.
 *
 * A file with the name the chip already asks for (a new build of the same firmware)
 * replaces the stored one and leaves the schematic alone.
 */
export async function giveFirmware({ chip, file, doc, save, edit }: GiveFirmware): Promise<string> {
  const ext = firmwareExtension(chip);
  const name = firmwareName(file.name, ext);
  if (!name) throw new Error(`"${file.name}" is not a firmware file for ${chip.ref}: its name has to end in ${ext}`);
  if (file.size > MAX_FIRMWARE_UPLOAD_BYTES) throw new Error(`"${file.name}" is not taken: ${firmwareProblem(file.size, new Uint8Array())}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problem = firmwareProblem(bytes.length, bytes, chip.chip, ext);
  if (problem) throw new Error(`"${file.name}" is not taken: ${problem}`);

  const rename = name !== chip.name;
  // a session without a shared document cannot change a symbol from the page
  if (rename && !doc) throw new Error(`Here ${chip.ref} only takes a file named "${chip.name}": this session cannot change the schematic from the list`);
  if (rename && !symbolText(doc!, chip.uuid))
    throw new Error(`${chip.ref} is not on the sheet that is shown. Open its sheet, then choose the file`);

  const saved = await save(name, bytes);
  if (saved.kind !== "committed") throw new Error(`"${name}" was not stored in the project${saved.message ? `: ${saved.message}` : ""}`);
  if (!rename) return name;

  try {
    // read again: the upload took a while, and the symbol may have been moved meanwhile
    const symbol = doc && symbolText(doc, chip.uuid);
    if (!symbol) throw new Error("its symbol is no longer on the sheet that is shown");
    await edit({ label: `Firmware of ${chip.ref}`, upsert: [{ sexpr: withFirmware(symbol, name) }], remove: [] });
  } catch (e) {
    throw new Error(`"${name}" is in the project, but ${chip.ref} could not be changed: ${words(e)}. Choose the file again to try once more`);
  }
  return name;
}
