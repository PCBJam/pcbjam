// An AVR chip's program as Intel HEX text, read into the bytes of the chip's program memory.
import { describe, expect, it } from "vitest";
import { HEX_PROGRAM_MAX, readIntelHex } from "./intel-hex";

/** One record: its length, address, type and data, with the checksum the format asks for. */
function record(at: number, type: number, data: number[]): string {
  const b = [data.length, (at >> 8) & 255, at & 255, type, ...data];
  const sum = (256 - (b.reduce((a, x) => a + x, 0) & 255)) & 255;
  return ":" + [...b, sum].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join("");
}
const END = ":00000001FF";

describe("reading Intel HEX text", () => {
  it("gives the program's bytes from address 0", () => {
    // the first two lines of a Blink sketch as the Arduino build writes it
    const text = ":100000000C945C000C946E000C946E000C946E00CA\r\n:100010000C946E000C946E000C946E000C946E00A8\r\n:00000001FF\r\n";
    const got = readIntelHex(text);
    expect(got).toHaveLength(32);
    expect([...got.subarray(0, 4)]).toEqual([0x0c, 0x94, 0x5c, 0x00]);
    expect([...got.subarray(28)]).toEqual([0x0c, 0x94, 0x6e, 0x00]);
  });

  it("leaves 0xff where the file writes nothing, in whatever order its lines come", () => {
    const got = readIntelHex([record(8, 0, [1, 2]), record(0, 0, [9]), END].join("\n"));
    expect([...got]).toEqual([9, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 2]);
  });

  it("follows the address records of a program past 64 kB", () => {
    const linear = readIntelHex([record(0, 0, [1]), record(0, 4, [0, 1]), record(4, 0, [7]), END].join("\n"));
    expect(linear).toHaveLength(0x10005);
    expect([linear[0], linear[0x10004], linear[5]]).toEqual([1, 7, 0xff]);
    const segment = readIntelHex([record(0, 2, [0x10, 0]), record(2, 0, [5]), record(0, 3, [0, 0, 0, 0]), END].join("\n"));
    expect(segment[0x10002]).toBe(5);
  });

  it("says in words why a text is not a program", () => {
    expect(() => readIntelHex("just words")).toThrow("it is not an Intel HEX file (.hex)");
    expect(() => readIntelHex(":1000000")).toThrow("it is not an Intel HEX file (.hex)");
    expect(() => readIntelHex([record(0, 9, [1]), END].join("\n"))).toThrow("it is not an Intel HEX file (.hex)");
    expect(() => readIntelHex(":100000000C945C000C946E000C946E000C946E00CB\n" + END)).toThrow("a line of the HEX file is damaged (its checksum is wrong)");
    // a length that is not the line's
    expect(() => readIntelHex(":030000000C00F1\n" + END)).toThrow("a line of the HEX file is damaged (its checksum is wrong)");
    expect(() => readIntelHex("")).toThrow("the HEX file is empty or cut off");
    expect(() => readIntelHex(END)).toThrow("the HEX file is empty or cut off");
    expect(() => readIntelHex(record(0, 0, [1, 2]))).toThrow("the HEX file is empty or cut off");
    expect(() => readIntelHex([record(0, 0, [1]), END, record(1, 0, [2])].join("\n"))).toThrow("it has lines after its end record");
  });

  it("does not let an address decide how much memory is taken", () => {
    const far = [record(0, 4, [0x7f, 0xff]), record(0, 0, [1]), END].join("\n");
    expect(() => readIntelHex(far)).toThrow("the program is larger than 1 MB, more than any chip here holds");
    const edge = readIntelHex([record(0, 4, [0, 0x0f]), record(0xffff, 0, [1]), END].join("\n"));
    expect(edge).toHaveLength(HEX_PROGRAM_MAX);
  });
});
