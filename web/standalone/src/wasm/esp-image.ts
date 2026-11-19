/**
 * An ESP32 firmware image, judged before a chip runs it (live simulation).
 *
 * The emulator starts a chip the way a board does: from address 0 of its flash. So the
 * file has to be the whole flash, the "merged" image: the bootloader, the partition table
 * and the program in one file. A build also writes the program alone (firmware.bin,
 * sketch.ino.bin). That file starts with the same byte and names the same chip, and a chip
 * that is given it at address 0 crashes and restarts without end. Both kinds say which
 * they are in their first bytes, so the file is refused in words before it is stored, and
 * before a chip is started with one that came into the project another way.
 */
import { FIRMWARE_CHIPS, FIRMWARE_SNIFF_BYTES, firmwareChipId, looksLikeFirmware } from "@pcbjam/shared";

/** How many of a file's first bytes `imageProblem` reads. */
export const IMAGE_HEAD_BYTES = 36;

/** Where an image's first segment starts: after the image's header and the segment's own. */
const FIRST_SEGMENT = 32;
/**
 * The word a program starts with: ESP-IDF's description of the app (esp_app_desc_t,
 * 0xABCD5432), which its build puts first into the program's first segment. A bootloader,
 * and so a merged image, has something else there.
 */
const PROGRAM_MARK = [0x32, 0x54, 0xcd, 0xab] as const;

const MERGED_IS_NEEDED = "The merged image is needed: the one file that is written to the chip at address 0";

/** True for an image that holds the program alone, without the bootloader in front of it. */
export function isProgramAlone(head: Uint8Array): boolean {
  return head.length >= FIRST_SEGMENT + PROGRAM_MARK.length && PROGRAM_MARK.every((byte, i) => head[FIRST_SEGMENT + i] === byte);
}

/**
 * Why a `.bin` is not an image this chip starts from, in words, or null. `head` is the
 * file, or at least its first IMAGE_HEAD_BYTES. With `chip` (what the part is, as its
 * emulator names it) an image built for another chip is not one either.
 */
export function imageProblem(head: Uint8Array, chip?: string): string | null {
  const header = head.subarray(0, FIRMWARE_SNIFF_BYTES);
  if (!looksLikeFirmware(header)) return `it does not start like an ESP32 firmware image. ${MERGED_IS_NEEDED}`;
  // a chip this list does not have is left to its emulator, which says so at Play
  const wanted = chip ? FIRMWARE_CHIPS.find((c) => c.chip === chip) : undefined;
  const id = firmwareChipId(header);
  if (wanted && id !== wanted.id) {
    const built = FIRMWARE_CHIPS.find((c) => c.id === id);
    const other = built ? `the ${built.title}` : `another chip (number 0x${(id ?? 0).toString(16).padStart(4, "0")})`;
    return `it was built for ${other}, and this chip is an ${wanted.title}`;
  }
  if (isProgramAlone(head))
    return `it holds the program alone, without the bootloader. ${MERGED_IS_NEEDED} (the Arduino IDE writes it as the .merged.bin of Sketch > Export Compiled Binary)`;
  return null;
}
