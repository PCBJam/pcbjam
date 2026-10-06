# @pcbjam/kicad-tools

Headless KiCad for scripts and AI agents: one command, `pcbjam-tools`, over
two WebAssembly builds of KiCad —

- `kicad_tools` (≈28 MB): ERC, DRC, lint, resave, netlist, BOM, gerbers,
  drill, schematic and board plots, and the shots below;
- `occ_service` (≈60 MB, OpenCASCADE): STEP / STEPZ / GLB / STL export. It is
  only downloaded the first time you run a 3D command.

No KiCad install needed; Node 20+.

## Run

```sh
npx -y --package=https://cdn.pcbjam.com/tools/kicad-tools/<version>/kicad-tools.tgz pcbjam-tools <command>
```

The PCBJam MCP's `get_local_cli` tool returns the current URL.

```sh
pcbjam-tools --erc --json board.kicad_sch report.json      # any kicad_tools flags, unchanged
pcbjam-tools --drc --json board.kicad_pcb report.json
pcbjam-tools board-shot board.kicad_pcb top.png --preset top --crop 120,80,30,20
pcbjam-tools schematic-shot board.kicad_sch sheet.png --sheet power
pcbjam-tools board-3d-shot board.kicad_pcb board.png --view iso --models cdn
pcbjam-tools step board.kicad_pcb board.step --models ~/kicad-packages3D
pcbjam-tools where                                         # which builds are in use
```

- **Shots** are KiCad's own plots made to look at: cropped to an area
  (`--crop cx,cy,halfW,halfH`, millimetres in the file's coordinates), on the
  editor's background (`--background color|none`), as PNG (`--width px`;
  needs the optional `sharp` package) or SVG. Board presets: `top`,
  `bottom`, `copper`, `editor` (every enabled layer); or `--layers a,b,…`.
- **3D shots** (`board-3d-shot`): the board with tracks, silkscreen,
  soldermask and component models, rendered in software (no GPU) to PNG.
  Views: `iso` (default), `top`, `bottom`, `iso-back`, `front`, or
  `--azimuth`/`--elevation` in degrees; `--crop` frames board millimetres.
- **STEP** and 3D shots read library models from `--models <dir>` in the
  official `<lib>.3dshapes/<name>.<ext>` layout or `--models cdn` (PCBJam's
  model CDN; `--models-manifest <url>`), plus `--models-dir <dir>` for models
  fetched elsewhere (e.g. team libraries); project models (`${KIPRJMOD}/…`)
  are read next to the board. Missing models are listed, never silently
  dropped.

Exit codes follow kicad_tools: 0 ok, 1 violations found, 2 usage, 4 input
invalid.

## Where the WebAssembly comes from

0. `KICAD_TOOLS_JS` — an exact `kicad_tools.js` (overrides the lookup below
   for kicad_tools only);
1. `KICAD_TOOLS_WASM_DIR` — a directory with `kicad_tools.{js,wasm}` (and
   `occ_service.{js,wasm}`), e.g. a local build or a container image;
2. the cache (`~/.cache/pcbjam/wasm/<tool>/<version>/`), filled from
3. the CDN at the versions pinned in `manifest.json`, each file checked
   against its sha256.

## License

GPL-3.0-or-later, like KiCad. The source is in the PCBJam editor repository
(`web/kicad-tools`, KiCad fork under `kicad/`).
