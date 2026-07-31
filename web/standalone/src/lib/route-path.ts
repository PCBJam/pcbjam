/**
 * React Router (v6) decodes NAMED params but leaves the `*` splat
 * percent-encoded, so a file deep-link like
 *
 *   /:scope/projects/arduino/Repo-main/KiCad%20Projects/Mega.kicad_pcb
 *
 * yields `name: "arduino"` (decoded) and a splat that still reads
 * `Repo-main/KiCad%20Projects/Mega.kicad_pcb`. Every consumer of the resulting
 * `targetPath` expects the DECODED form — the project file list carries real
 * spaces, `encodePath` (project-source) re-encodes per segment when building
 * API URLs, and MEMFS paths are raw. Left encoded, the target matches no file:
 * the API URL double-encodes to `%2520`, the open fails, and KiCad quits —
 * which the quit hook turns into a bounce back to the project page.
 *
 * Decodes per SEGMENT so an encoded separator (`%2F`) inside a name can never
 * silently become a path boundary, and falls back to the raw segment when the
 * encoding is malformed (a lone `%`), since a wrong-but-stable path is easier
 * to diagnose than a thrown route render.
 */
export function decodeRoutePath(splat: string): string {
  return splat
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}
