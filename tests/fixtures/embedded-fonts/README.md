# Embedded-font fixtures

Used by `tests/kicad/embedded-fonts.spec.ts`. Each document has two texts with the same
string, "FONT TTF": one in the TrueType face `wxprivate` (uuid `...0002`), one in the
KiCad stroke font (uuid `...0003`). The two lay out to different widths, so comparing
their bounding boxes shows which font a text resolved to.

| File | What it is |
| --- | --- |
| `wxprivate.ttf` | The test font, copied from `wxwidgets/samples/font/wxprivate.ttf` (wxWindows Library Licence, like the rest of wxWidgets). 21 KB, family name `wxprivate`, which no system has installed. |
| `embedded-font.kicad_pcb` | A board with `(embedded_fonts yes)`, the font embedded once, and the `render_cache` KiCad writes for outline text. Saved by native `kicad-cli pcb upgrade --force` (KiCad 10.0.6), so the zstd + base64 payload and the MMH3 checksum are what desktop KiCad writes. |
| `embedded-font-nocache.kicad_pcb` | The same board without the `render_cache`, so the glyphs must come from the font. |
| `face-only.kicad_pcb` | The text names the `wxprivate` face, but nothing is embedded (`embedded_fonts no`): a desktop board that relies on a system font. |
| `embedded-font.kicad_sch` | A schematic with the same two texts and the same embedded block. |

How they were made: a hand-written board embedding the font (zstd level 15, base64 in
76-character lines between `|...|`, sha256 checksum, which KiCad accepts on load) was
re-saved with `kicad-cli pcb upgrade --force`. kicad-cli re-embeds a font it read from
its embed cache under a second name (`kicad_embedded_<hash>.ttf`), because the font is
not installed on the machine. Only the original entry was kept. That is what desktop
KiCad writes when the font is installed. `kicad-cli sch upgrade` drops a schematic's
embedded files, so the schematic got the board's canonical block by hand.
Natively (`kicad-cli pcb export svg`), the embedded board draws "FONT TTF" in
`wxprivate`, and `face-only` falls back to a system sans (Verdana on macOS).
