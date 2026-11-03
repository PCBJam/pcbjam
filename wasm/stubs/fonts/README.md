# Fallback font

`NotoSans-Regular.ttf` is Noto Sans Regular 2.015, unhinted, from
https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/unhinted/ttf/NotoSans-Regular.ttf
(sha256 `f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8`).
It is licensed under the SIL Open Font License 1.1 (`OFL.txt`, from
https://github.com/notofonts/latin-greek-cyrillic).

The browser build has no system fonts. When a document names a font that is neither embedded
nor available in the browser, `../fontconfig_wasm.cpp` answers with this font as a substitute,
the way fontconfig substitutes an installed font on the desktop. KiCad then keeps the font name
the document asked for (`OUTLINE_FONT::LoadFont`), instead of falling back to the stroke font
and saving the text as "KiCad Font".

The font is compiled into kicommon (`fallback_font.cmake`), so the editors and `kicad_tools`
both have it, and written to `/tmp/pcbjam-fonts` at startup (MEMFS in the browser, the host's
`/tmp` for `kicad_tools` on node). That copy is marked "preview and print" in its OS/2 `fsType`,
so KiCad never embeds the stand-in into a document: it only draws text whose real font is
missing. The file in this folder is unmodified.
