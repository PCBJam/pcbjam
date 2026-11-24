// Joining a part's thermal pins to wires from the page (live simulation).
//
// Heat is drawn as a circuit: on a wire that carries heat 1 V is 1 degree Celsius and 1 A
// is 1 W, and the user draws what the heat goes into with ordinary parts (the thermal part
// of @pcbjam/shared/sim-library). A part that has to do with heat has thermal pins: a
// heater gives its heat to its pin's wire, a temperature sensor is as warm as it, a fan
// moves air between the wires of its two pins. KiCad's symbols draw no such pin, so the
// pin is on the wire whose name the symbol's field PCBJam.SimThermal says. On the part's
// line in the Simulation parts list the user types the names; they are written onto the
// symbol as one edit of the schematic, so it can be undone and collaborators get it. No
// names take the part off its wires.
//
// The symbol is changed the way a chip gets its firmware (chip-firmware.ts): through the
// editor's own edit path, with the symbol's text from the shared document of the shown
// sheet.
import type * as Y from "yjs";
import { FIELD_THERMAL, WIRE_NAME, type ThermalPin } from "@pcbjam/shared/sim-library";
import type { EditRequest } from "@/plugins/edits";
import { symbolText, withSymbolField } from "./chip-firmware";

/** Why a text cannot be a wire's name, in words, or null. An empty one is "no wire". */
export function wireNameProblem(name: string): string | null {
  const said = name.trim();
  if (!said || WIRE_NAME.test(said)) return null;
  return `"${said}" cannot be a wire's name: it is the text of a label, without a blank`;
}

/** What the line of a thermal pin says in front of its wire's name. */
export function thermalPinLabel(pins: readonly ThermalPin[], index: number): string {
  const pin = pins[index];
  if (!pin) return "";
  if (pin.does === "air") return pins.findIndex((p) => p.does === "air") === index ? "Air between" : "and";
  return pin.does === "heats" ? "Heats the wire" : pin.does === "feels" ? "Feels the wire" : "Heats and feels the wire";
}

/** What the tip of a thermal pin's line says. */
export function thermalPinTip(ref: string, pin: ThermalPin): string {
  const wire = "Type the name of a label on a wire. On a wire that carries heat 1 V is 1 °C and 1 A is 1 W.";
  if (pin.does === "air")
    return `${ref} carries heat between two wires, from the warmer to the cooler, more the faster it turns. ${wire} The box it cools is one wire, the air outside the other. Empty: it moves no heat.`;
  if (pin.does === "feels") return `${ref} is as warm as this wire. ${wire} Empty: a slider sets its temperature.`;
  return `${ref} gives its heat to this wire: every watt it takes is 1 A into it. ${wire} A capacitor from the wire to ground holds the heat, a resistor to a voltage source lets it out to the air outside. Empty: its heat goes nowhere.`;
}

export interface PutOnWires {
  /** The symbol's uuid. */
  uuid: string;
  ref: string;
  /** The wires' names in the order of the part's thermal pins. Empty ones are left out; none takes the part off its wires. */
  names: readonly string[];
  /** The shared document of the shown sheet. Null in a session without one. */
  doc: Y.Doc | null;
  /** Changes items of the shown sheet as one step of the schematic's history. */
  edit: (request: EditRequest) => Promise<unknown>;
}

/**
 * Writes the names of its wires onto the part's symbol. Resolves with the names as they
 * were written. Rejects with a sentence for the user; nothing is changed then.
 */
export async function putOnWires({ uuid, ref, names, doc, edit }: PutOnWires): Promise<string[]> {
  const said = names.map((n) => n.trim()).filter(Boolean);
  for (const name of said) {
    const problem = wireNameProblem(name);
    if (problem) throw new Error(problem);
  }
  // a session without a shared document cannot change a symbol from the page
  if (!doc) throw new Error("This session cannot change the schematic from the list");
  const symbol = symbolText(doc, uuid);
  if (!symbol) throw new Error(`${ref} is not on the sheet that is shown. Open its sheet, then name its wires`);
  const label = said.length ? `${ref} on the heat ${said.length === 1 ? "wire" : "wires"} ${said.join(" and ")}` : `${ref} off its heat wires`;
  await edit({ label, upsert: [{ sexpr: withSymbolField(symbol, FIELD_THERMAL, () => said.join(" ")) }], remove: [] });
  return said;
}
