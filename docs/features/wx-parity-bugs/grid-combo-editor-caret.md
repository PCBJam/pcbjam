# Grid combo editor typing: `eRsistor_SMD:R_0805` (stale wxTextEntry caret)

Status 2026-09-04: FIXED. Root-caused 2026-09-02, reproduced deterministically
by `tests/kicad/grid-combo-editor-caret.spec.ts` (RED on both engines), fixed
by wx `74fd3a756e` on `staging-wasm-port` (cherry-pick of `c5bef486e7`, see
"Fix" below) — the spec is GREEN on `kicad-firefox` and `kicad-chromium`
against that build. Companion of the eeschema `R` double-rotate investigation
(that half landed earlier: wx `b323f36fffd`, pcbjam `4c10756`).

## Symptom

`tests/kicad/grid-editors-typing.spec.ts` types `Resistor_SMD:R_0805` into the
Symbol Properties → Footprint cell right after double-clicking it and, on
Firefox, sometimes reads back `eRsistor_SMD:R_0805`: the second character lands
in front of the first, everything after it is in order. The spec's `{ delay: 40 }`
comment blames "Firefox reordering characters typed at full speed" — that is
not what happens. Today (pairing-fix build, wx `b323f36`) the flow passed 6/6
on Firefox; the failure is a timing window, not a Firefox property.

## Two things combine

### 1. Product defect: the wasm `wxTextEntry` caret is a C++ cache that disagrees with the `<input>`

`wxwidgets/src/wasm/textentry.cpp` keeps `m_insertionPoint` / `m_selection*`
in C++ only:

- `DoSetValue()` sets the cache caret to 0 (`textentry.cpp:220-232`). That is
  wx-native parity — wxMSW and wxGTK both `SetInsertionPoint(0)` after
  `SetValue` — but the DOM element that the user sees does the opposite:
  `el.value = v` (`wx-dom.js` `wxDomSetValue`) leaves the browser caret at the
  END of the text.
- The `input`-event import (`wxTextCtrl::OnDomEvent(INPUT)` →
  `wxTextEntry::DoSetValue`) resets the cache caret to 0 after every natively
  typed character too, while the real caret sits after the typed text.
- `WriteText()` inserts at the cached position and then pushes the whole
  value into the DOM (`textctrl.cpp:78-88`), which moves the browser caret to
  the end again.

So any wx-side `WriteText` into a DOM-backed text control that already holds
text inserts at offset 0 while the caret is drawn at the end. The KiCad path
that does exactly that is `wxGrid::OnChar` → `DoEnableCellEditControl` →
`GRID_CELL_TEXT_BUTTON::BeginEdit` (`Combo()->SetValue(cell value)`,
`Combo()->SetFocus()`) → `GRID_CELL_TEXT_BUTTON::StartingKey` →
`wxTextEntry::WriteText(ch)` (`kicad/common/widgets/grid_text_helpers.cpp:401-470`).
Cell holds `R`, key is `e` → `eR`; the rest of the string is typed natively into
the now-focused `<input>` after its (end) caret → `eRsistor_SMD:R_0805`.

### 2. Trigger in the wild: KiCad's auto-size commits and hides the editor under the typist

- `WX_GRID` sets `m_gridWidthsDirty` on every `wxEVT_GRID_CELL_CHANGED` and
  runs `RecomputeGridWidths()` from `wxEVT_UPDATE_UI`
  (`kicad/common/widgets/wx_grid.cpp:1075-1136`).
- `RecomputeGridWidths` → `wxGrid::AutoSizeColumn` → `AutoSizeColOrRow`, whose
  first statement is `AcceptCellEditControlIfShown()`
  (`wxwidgets/src/generic/grid.cpp:10425`): the open Footprint editor is
  committed (`R` → table) and hidden; `DoHideCellEditControl` gives wx focus to
  the grid window, which calls `wxDomBlurActive()`; Firefox also drops focus to
  `<body>` for a `display:none`'d focused input.
- The spec's previous step (Value cell committed via Enter) is the
  `CELL_CHANGED` that made the widths dirty. The wasm event loop runs
  `ProcessIdle()` — and with it `UPDATE_UI` — only every third dispatch tick
  (`wxwidgets/src/wasm/evtloop.cpp:243-252`), so the recompute can land tens of
  ms after the Footprint editor opened, i.e. after the first typed character.
- With the input blurred, the next key goes to the window-level `KeyCallback`
  (`app.cpp:1031-1069`, the "is a DOM editable focused" check fails) → wx →
  `wxGrid::OnChar` → the reopen-by-key path of §1.

The trace in the original investigation matches step by step (input event for
`R`; ~28 ms later blur → BODY; `e` keydown with BODY active; refocus 14 ms
later from `BeginEdit`'s `SetFocus`; `wxDomSetValue("eR")` from `WriteText`).

Natively the same auto-size hide exists, but `UPDATE_UI` runs at every idle so
it fires before a human reaches the next cell. Only automation (or the
throttled wasm idle) opens the window. A human CAN hit the product defect
directly: select a filled Footprint/Datasheet/URL cell and type — the char is
prepended.

## Reproduction (deterministic, both engines)

`tests/kicad/grid-combo-editor-caret.spec.ts` — no race. The fixture's
Footprint property already holds `R`, so nothing is committed and the
auto-size pass of §2 never runs:

1. Click the read-only Name cell of the Footprint row: `wxGrid` disables the
   Reference editor the dialog opened on show (value unchanged → no
   `CELL_CHANGED`), the Name cell cannot open an editor, the grid window takes
   wx focus (browser focus → `<body>`).
2. `ArrowRight` puts the cursor on the Footprint cell (no editor), type `e`:
   `OnChar` → `BeginEdit("R")` + `StartingKey('e')` → `WriteText`.
3. Type `sistor_SMD:R_0805` natively; expect `Resistor_SMD:R_0805` in the input
   AND in the saved file (OK commits the open editor).

Actual today (2026-09-02, wx `b323f36` build): `eRsistor_SMD:R_0805` on both
`kicad-chromium` and `kicad-firefox` — the exact string from the flaky spec.
The spec attaches a DOM/wx-dom trace (`focusin/out`, keys, `wxDomSetValue`,
`wxDomFocus`, `wxDomBlurActive`, `wxDomSetShown`; echoed to the log on failure).

An earlier variant of the spec typed `R` natively and committed it before the
reopen; that commit's `CELL_CHANGED` made §2's auto-size pass run ~25 ms later
and, on Firefox, it hid the just-reopened editor AGAIN (`wxDomSetShown 0` +
`wxDomBlurActive` 10 ms after `WriteText`), so the next key was prepended too:
`seRistor_SMD:R_0805`. Each hide + reopen-by-key prepends one more character.
That variant is RED on both engines as well, but with a timing-dependent
string; the fixture-seeded version above is the gate.

Expected value = "the character goes where the caret is drawn" (end of the
text, where `el.value = v` leaves it). wxGTK/macOS would instead select-all on
focus and REPLACE the content; KiCad's `GRID_CELL_TEXT_BUTTON::BeginEdit` does
not ask for either (`wxGridCellTextEditor::DoBeginEdit` does
`SetInsertionPointEnd(); SelectAll()`). Changing that is a KiCad UX decision,
out of scope here; the port's contract is: never insert somewhere other than
the visible caret/selection.

## Fix (landed 2026-09-04)

### Step 1 — wx port: read the live DOM caret/selection (done: wx `74fd3a756e`)

The unmerged wx commit `c5bef486e7a4752b664d68ae79125a730a6a0515`
("fix(wasm): live DOM caret/selection for wxTextEntry (parity H-3)", on
`origin/wxwidgets-diff`) was cherry-picked (`-x`, message extended with the
grid reproduction) onto `staging-wasm-port` `0a2712c7c0` as `74fd3a756e` —
5 files, +126/−13, no conflicts:

- `build/wasm/wx-dom.js`: `wxDomGetSelectionStart/End`, `wxDomSetSelection`
  (with the one-shot re-apply on focus for a selection set while blurred);
  `wxDomSetValue` skips no-op assignments so a selection set by wx is not
  collapsed by an identical value push.
- `include/wx/wasm/private/dom.h`: the three bridges.
- `include/wx/wasm/textentry.h` / `src/wasm/textentry.cpp`: `WasmDomId()`;
  `GetInsertionPoint`/`GetSelection` read the DOM when the element exists
  (cache fallback before creation / for non-selectable input types, where the
  getters return −1); `SetInsertionPoint`/`SetSelection` push to the DOM;
  `WriteText` computes the position from the live selection, inserts, then
  mirrors value + caret (`wxDomSetValue` then `wxDomSetSelection`).
- `src/wasm/textctrl.cpp`: `WriteText` no longer re-pushes the value (the base
  now does, and a second push would reset the caret to the end).

After it, §1's path inserts at the DOM caret (end) → `Re`; the `input`-event
import no longer matters because nothing reads the cache while the element
exists. `wxComboBox` (editable) gets the same via the shared mixin.

Review points while landing:
- Keep `wxComboBox::DoSetValue`'s `m_inDomInput` guard and
  `wxTextCtrl::DoSetValue`'s push as they are; the no-op skip in
  `wxDomSetValue` makes the echo case harmless anyway.
- `wxTextEntry::DoSetValue` may keep the cache at 0 (native parity) — it only
  matters before the element exists (`Create` → `ChangeValue`).
- Multiline `<textarea>` supports `setSelectionRange`; `<input type=number>`
  throws → the try/catch → −1 → cache fallback (already in the commit).
- Dialogs that `SetSelection(-1,-1)` before `SetFocus` (select-all-on-open)
  will now really show the selection: expect morelli screenshot diffs on such
  dialogs (Edit Text, chooser filters). Promote after eyeballing.

### Step 2 — KiCad side: nothing required (unchanged)

`GRID_CELL_TEXT_BUTTON::BeginEdit` stays as upstream. Optional later UX
alignment (`SetInsertionPointEnd()` / `SelectAll()` like `wxGridCellTextEditor`)
is a separate, upstream-facing decision.

### Step 3 — tests (done, except the optional item)

1. `tests/kicad/grid-combo-editor-caret.spec.ts`: RED on both engines against
   the previous build (`eRsistor_SMD:R_0805`), GREEN on `kicad-firefox` and
   `kicad-chromium` against the wx `74fd3a756e` build (input value and saved
   file both `Resistor_SMD:R_0805`).
2. `tests/kicad/grid-editors-typing.spec.ts` stays green on both engines. The
   `{ delay: 40 }` was KEPT, only its comment was corrected: the pacing is not
   about Firefox reordering, it keeps at most one key inside the auto-size
   hide/reopen window. With the caret fix that one key lands correctly; a
   second key inside the same window would be dropped, not misplaced (see
   "Not part of this fix"), so typing at full speed would trade a fixed bug
   for a rarer flake.
3. Wx-level regression (host `build-wx-wasm.sh` + `build-wasm-test.sh`,
   `wx-chromium`): dom-port-bugs, gridedit, grid, textdataobj, wxwidgets,
   uipolish, propgrid, clipboard, stc, dataview, dataviewvirtual, listctrl,
   calendar, ownerdrawn, radiogroups, tree, tree-hier — 98 passed. KiCad-side
   regression on both engines: footprint-chooser-confirm, infobar-dismiss,
   findings-p, import-settings-modal-stack, pl_editor, load-pcb,
   eeschema-rotate (see the landing commit for the result).
4. NOT done (optional, still open): a standalone wx app
   `tests/apps/standalone/textentry-caret/` (pattern of `textctrl-reentry`,
   `Makefile.wasm` rule + a case in `tests/e2e/dom-port-bugs.spec.ts`): a
   `wxTextCtrl`, type `R` natively, a button calls `WriteText("e")` and logs
   `[REPRO] caret: value=<v> pos=<GetInsertionPoint()>`; expect `Re` / 2.
   Also covers `SetSelection` + `SetFocus` ordering (select-all-on-open) and
   `GetSelection` after a native mouse selection.
5. The auto-size race itself is not testable deterministically (timer-paced
   idle); it is documented here and covered indirectly by (2).

### Step 4 — landing

Chain used: wx `fix/wasm-textentry-live-caret` cut from `staging-wasm-port`
`0a2712c7c0` (the cherry-pick, `74fd3a756e`) → pcbjam pointer bump + the new
spec + this doc + the typing-spec comment → root pointer bump → ff-only onto
the staging lines (`staging-wasm-port` / `staging` / `staging`); the staging
CI (`deploy-staging.yml`) builds, runs the e2e suites and deploys from the
push. Local pre-landing build: `CACHE_PROJECT=kicad-wasm-findings-group-e
scripts/build-pcbjam.sh kicad_editor` took ~12 min on the warm cache (the wx
header change recompiled KiCad; in CI expect the ~50 min container step).

### Not part of this fix (noted)

- Idle cadence: `ProcessIdle` every third tick delays every `UPDATE_UI`
  handler by up to ~50 ms; fine for humans, but it is why automation can type
  into an editor the grid is about to hide. Running idle after each dispatched
  DOM job would close the window; separate change if the typing spec ever
  flakes again after Step 1.
- `KeyCallback` routing while an editable is mid-blur is correct: once the
  input is hidden the key MUST go to wx (that is what reopens the editor).
- Residual after Step 1, race only: two keys arriving while the editor is
  hidden queue two wx key jobs; the first reopens the editor, the second finds
  it enabled and `wxGrid::OnChar` skips it — the wasm `wxTextCtrl` does not
  insert on `wxEVT_CHAR` (the DOM types), so that character is DROPPED, not
  misplaced. Needs the idle-cadence change above or a wx-side `EmulateKeyPress`
  for DOM-backed text controls; not observed with Playwright's per-key pacing.
