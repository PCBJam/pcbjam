import { describe, expect, it } from "vitest";
import { IMAGE_HEAD_BYTES, imageProblem, isProgramAlone } from "./esp-image";

const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
// The first bytes of two files one build of an ESP32-C3 sketch wrote. The merged image
// starts with the bootloader; the other file is the program alone.
const MERGED = bytes("e903022f10bf3c40ee0000000500000000ffff00000000012058cd3f0c110000500000000100000076352e35");
const ALONE = bytes("e906022fdc083840ee0000000500000000ffff00000000012000033cf02801003254cdab0000000000000000");

describe("an ESP32 image, judged before a chip runs it", () => {
  it("takes the merged image of the chip", () => {
    expect(imageProblem(MERGED, "esp32c3")).toBeNull();
    expect(imageProblem(MERGED)).toBeNull();
    expect(isProgramAlone(MERGED)).toBe(false);
    // the first bytes are enough
    expect(imageProblem(MERGED.subarray(0, IMAGE_HEAD_BYTES), "esp32c3")).toBeNull();
  });

  it("refuses the program alone, and says which file is needed", () => {
    expect(isProgramAlone(ALONE)).toBe(true);
    expect(imageProblem(ALONE, "esp32c3")).toBe(
      "it holds the program alone, without the bootloader. The merged image is needed: the one file that is written to the chip at address 0 (the Arduino IDE writes it as the .merged.bin of Sketch > Export Compiled Binary)",
    );
    expect(imageProblem(ALONE)).toMatch(/^it holds the program alone/);
    expect(imageProblem(ALONE.subarray(0, IMAGE_HEAD_BYTES), "esp32c3")).toMatch(/^it holds the program alone/);
  });

  it("says first that a file was built for another chip", () => {
    expect(imageProblem(MERGED, "esp32s3")).toBe("it was built for the ESP32-C3, and this chip is an ESP32-S3");
    expect(imageProblem(ALONE, "esp32s3")).toBe("it was built for the ESP32-C3, and this chip is an ESP32-S3");
    const unknown = MERGED.slice();
    unknown[12] = 0x77;
    expect(imageProblem(unknown, "esp32c3")).toBe("it was built for another chip (number 0x0077), and this chip is an ESP32-C3");
    // a chip the list does not have is left to its emulator
    expect(imageProblem(MERGED, "esp99")).toBeNull();
  });

  it("refuses what is no image", () => {
    expect(imageProblem(new TextEncoder().encode("just words, long enough to fill a header and more"), "esp32c3")).toMatch(/^it does not start like an ESP32 firmware image/);
    expect(imageProblem(MERGED.subarray(0, 10), "esp32c3")).toMatch(/^it does not start like/);
    expect(imageProblem(new Uint8Array(0))).toMatch(/^it does not start like/);
    // a file cut off before the first segment is not called a program
    expect(isProgramAlone(ALONE.subarray(0, 34))).toBe(false);
  });
});
