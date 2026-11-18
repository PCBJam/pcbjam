// An AVR chip's program as the Arduino build writes it: Intel HEX text (live simulation).
//
// The file is lines of the form ":LLAAAATT<data>CC": a length, an address, a record type,
// the data and a checksum. This reads it into the program's bytes, as they sit in the
// chip's program memory from address 0. A byte nothing was written to is 0xff, as on a
// chip that was erased.

/**
 * The largest program this reads. No chip of the library holds more, and the address in
 * a file must not decide how much memory the page takes.
 */
export const HEX_PROGRAM_MAX = 1024 * 1024;

/**
 * The bytes of a program from Intel HEX text, from address 0 to the last byte the file
 * writes. Throws an Error whose message says in words why the text is not a program.
 */
export function readIntelHex(text: string): Uint8Array {
  const records: { at: number; data: number[] }[] = [];
  let high = 0, size = 0, ended = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (ended) throw new Error("it has lines after its end record");
    if (!/^:([0-9a-fA-F]{2}){5,}$/.test(line)) throw new Error("it is not an Intel HEX file (.hex)");
    const b = (line.slice(1).match(/../g) ?? []).map((h) => parseInt(h, 16));
    const [len = 0, hi = 0, lo = 0, type = 0] = b;
    if (b.length !== len + 5 || b.reduce((a, x) => (a + x) & 255, 0) !== 0) throw new Error("a line of the HEX file is damaged (its checksum is wrong)");
    const data = b.slice(4, 4 + len);
    if (type === 0) {
      const at = high + hi * 256 + lo;
      if (at + len > HEX_PROGRAM_MAX) throw new Error(`the program is larger than ${HEX_PROGRAM_MAX / (1024 * 1024)} MB, more than any chip here holds`);
      if (len) records.push({ at, data });
      size = Math.max(size, at + len);
    } else if (type === 1) ended = true;
    else if (type === 2 && len === 2) high = ((data[0] ?? 0) * 256 + (data[1] ?? 0)) * 16;
    else if (type === 4 && len === 2) high = ((data[0] ?? 0) * 256 + (data[1] ?? 0)) * 65536;
    // 3 and 5 are start addresses: a chip starts where it starts
    else if (type !== 3 && type !== 5) throw new Error("it is not an Intel HEX file (.hex)");
  }
  if (!records.length || !ended) throw new Error("the HEX file is empty or cut off");
  const out = new Uint8Array(size).fill(0xff);
  for (const r of records) out.set(r.data, r.at);
  return out;
}

/**
 * The program memory of the AVR chips the library has boards for, in bytes. The adapter
 * that runs them has the same numbers (avr8js-adapter.js).
 */
export const AVR_PROGRAM_BYTES: Readonly<Record<string, number>> = { atmega328p: 32 * 1024 };

/**
 * Why a program is none for this chip, in words, or null: it needs more room than the
 * chip has, so it was built for a larger one. A chip this list does not have is left to
 * its adapter.
 */
export function programProblem(program: Uint8Array, chip: string | undefined): string | null {
  const room = chip === undefined ? undefined : AVR_PROGRAM_BYTES[chip];
  if (room === undefined || program.length <= room) return null;
  return `it holds ${Math.ceil(program.length / 1024)} kB of program and the board's chip has room for ${room / 1024} kB: it was built for another board`;
}
