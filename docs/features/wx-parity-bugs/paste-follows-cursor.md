# Paste: the pasted symbol/footprint did not follow the cursor (motion and timers withheld while a dispatch chain is parked)

Status 2026-09-15: FIXED in the wx port (see "Fix"); reproduced deterministically
by `tests/kicad/eeschema-paste-follows-cursor.spec.ts` and
`tests/kicad/pcbnew-paste-follows-cursor.spec.ts` (in-app, both engines) and
`tests/e2e/parked-motion.spec.ts` (wx-level, harness
`wxwidgets/tests/wasm/parked_motion_test.cpp`, Makefile target `parked-motion`)
— all RED on the pre-fix build, GREEN after. KiCad untouched.

## Symptom

Desktop KiCad: Ctrl+V pastes the items, attaches them to the pointer, the
preview follows every mouse move, and a click commits the placement where the
pointer is. In the wasm build the click still committed, but between Ctrl+V and
the click the preview stayed glued where the pointer was at the Ctrl+V moment
(eeschema: the copy was not even moved to the cursor — it sat on top of its
source until the click). Plain `M`-move of a selected item worked fine.

## Trace

Both paste paths start the interactive move with a *synchronous* action:

```
PCB_CONTROL::placeBoardItems        pcbnew/tools/pcb_control.cpp:2053
SCH_EDITOR_CONTROL::Paste           eeschema/tools/sch_editor_control.cpp:2800
  -> TOOL_MANAGER::RunSynchronousAction( ..::move, &commit )
  -> common/tool/tool_manager.cpp:368
        while( synchronousControl == STS_RUNNING )
        {
            wxYield();          // drains wx pending events
            wxMilliSleep( 1 );  // -> nanosleep -> wasm/shims/nanosleep_yield.c
        }                       //    = a JSPI park of THIS stack
```

That loop runs on the stack of the Ctrl+V key handler, which holds the port's
dispatch interlock (`wxWasmDispatchGuard`, `src/wasm/app.cpp` HandleKeyEvent).
Under JSPI the guard's destructor runs only when the chain completes, so
`wxWasmDispatchDepth` stays ≥ 1 for the whole placement — the port is "parked"
(`include/wx/wasm/private/dispatch.h`). `M`-move goes through `RunAction`
instead: the key chain returns, the guard is released, motion flows normally.

While parked, `wxApp::HandleMouseEvent`'s parked branch kept
`wxGetMousePosition()` fresh and re-posted BUTTON events to the target window
(`wxPostEvent`), but returned early for `wxEVT_MOTION`. The spin's `wxYield()`
(`wxGUIEventLoop::DoYieldFor` → `ProcessPendingEvents`) drained the posted
click, which is why clicking still placed the item. No motion ever reached
`WX_VIEW_CONTROLS::onMotion`, so `TOOL_DISPATCHER` never emitted
`TA_MOUSE_MOTION` and the move tool never woke up to follow the pointer.

This is the park site already named as row K7 in
`docs/features/async/21-park-site-audit.md` and in
`docs/features/async/22-absorbing-libcontext.md` ("The tool-body park site,
NAMED"). The context-park redesign described there remains the deeper
follow-up; this fix is the minimal wx-layer change that makes the existing
queue-while-parked discipline complete.

## Fix (wx port only: `src/wasm/app.cpp`, `include/wx/wasm/app.h`)

The parked branch now also queues `wxEVT_MOTION`, **coalesced to one queued
motion per drain**:

- `wxApp::m_parkedMotionQueued` is set when a motion is posted while parked and
  cleared by an override of `wxApp::ProcessPendingEvents()` (every drain:
  `wxWasmProcessEventsUngated`, the button tail, `DoYieldFor`) and by the
  normal (unparked) mouse path. The flag tracks "no drain since I posted", not
  "consumed", so it can never stick: under-posting is bounded to one drain,
  over-posting is a duplicate motion the receiver ignores.
- One motion is enough because KiCad's `WX_VIEW_CONTROLS::onMotion` reads the
  LIVE pointer (`KIPLATFORM::UI::GetMousePosition()` → the `m_mouseState` cache
  that `UpdateMouseState` keeps fresh even while parked) and `TOOL_DISPATCHER`
  derives motion from `GetMousePosition() != m_lastMousePos`; the queued
  event's own coordinates are irrelevant.
- Hover synthesis (enter/leave, cursor shape) stays skipped while parked — it
  walks the widget state the interlock protects; the next live motion re-syncs
  it. Wheel keeps its own mailbox replay.
- The DOM-widget mouse entry (`src/wasm/domevents.cpp` `wx_dom_mouse`) and the
  touch `precedingMotion` path reuse `HandleMouseEvent`, so they get the same
  behaviour.

Interlock argument: the queued motion is delivered only (a) by the parked
chain's own `wxYield()` — a deliberate pump point on the same C++ stack, which
the interlock permits and which the queued click already relies on — or (b) on
the first ungated tick after resume, exactly like queued buttons. No new class
of interleaving is introduced.

## Second half: the copy appeared only after the first mouse move (timers)

After the motion fix the user still had to nudge the mouse before the pasted
copy showed up. Same park, different message class: eeschema's
`initializeMoveOperation` moves the pasted items to the cursor in the model
right away, and `TOOL_MANAGER::ProcessEvent` asks the canvas to repaint;
`EDA_DRAW_PANEL_GAL::Refresh` repaints synchronously only if enough time has
passed since the last repaint, otherwise it arms its one-shot
`m_refreshTimer`. wx timers in the port go through the scheduler mailbox,
whose delivery tick refuses to run anything while the interlock is held — so
the refresh armed right after the paste stayed queued for the whole
placement, until the first motion made `Refresh` repaint synchronously. The
auto-pan timer and queued wheel ticks (zoom during the move) were stuck the
same way.

Fix (wx port: `include/wx/wasm/private/mailbox.h`, `src/wasm/evtloop.cpp`,
`src/wasm/timer.cpp`, `src/wasm/app.cpp`): `wxGUIEventLoop::DoYieldFor`
(the port's `wxYield`) now calls `wxWasmMailboxDeliverNested()`, which
delivers the due mailbox messages on behalf of the calling chain — native
wxYield semantics, where pending timer events run inside the yield. Consent
is scoped by depth: `wxWasmMailboxNestedBaseline` records the interlock depth
at which the nested drain started, and `wxWasmMailboxMustDefer()` (used by
`TimerCallbackFunc::Run` and `wxApp::HandleMouseWheelEvent`) lets a message
through only at exactly that depth. A delivered handler that suspends raises
the depth with its own guard, so a fresh browser entry arriving meanwhile
still defers. The top-level delivery tick (`wxWasmMailboxDeliver`) is
unchanged and still never runs over a parked chain.

Category mask (added 2026-09-16 after the first staging run): the nested
delivery runs only when the yield's mask includes `wxEVT_CATEGORY_TIMER`,
i.e. a plain `wxYield()`/`wxSafeYield()` (`wxEVT_CATEGORY_ALL` - the
RunSynchronousAction spin). `wxProgressDialog` updates yield with
`wxEVT_CATEGORY_UI|USER_INPUT`, and native wx keeps timer events pending
across those; KiCad drives every board/schematic load through that dialog
(`WX_PROGRESS_REPORTER`), so an unmasked nested delivery ran refresh/auto-pan
timers in the middle of a load. Staging CI on the unmasked build hung two
Firefox tabs in the open path in two of three runs (run 35088893676: S4's
trio boot never reached the loaded title; the ysync repro's first synchronous
snapshot call never returned; console silent for the whole test timeout, no
timer tripwire), 0 of 3 on the runs before. The gate restores the native
rule; the paste gates stay green (wxYield is an ALL-yield).

## Gates

- `tests/e2e/parked-motion.spec.ts` (wx-chromium): a "Start Spin" button whose
  handler arms a one-shot and a periodic wxTimer and then spins like
  `RunSynchronousAction` until the panel sees a motion, the one-shot fired and
  the periodic ticked twice, or 3 s pass. Pre-fix: `SPIN-START depth=1`,
  `CHECK parked-motion FAIL waited=3000`; with only the motion fix the timer
  checks still FAIL (`ticks=0`). Post-fix: all PASS within the first drains.
- `tests/kicad/{eeschema,pcbnew}-paste-follows-cursor.spec.ts`
  (kicad-chromium + kicad-firefox): boot with a one-item fixture, zoom to
  objects, Ctrl+A/Ctrl+C, pointer at A, Ctrl+V, wait until the pasted copy
  (fresh uuid) is selected, assert the copy is DRAWN at A before any mouse
  move (eeschema pre-fix: 0 changed pixels for 5 s), move to B; assert the GL
  canvas repainted (pre-fix 0.00 %), click, assert the committed item sits at B via
  `kicadCollabGetPos`/viewport mapping, plus the save sanity of
  `eeschema-copy-paste.spec.ts`.

Spec gotchas recorded on the way: eeschema snaps the paste point to a nearby
item anchor within ~2 grid units (A had to be moved away from the zoomed
symbol's origin/pins, otherwise the copy landed exactly on the original and
the pixel diff saw nothing); eeschema does not move pasted items to the cursor
until the first motion, so "preview appeared" cannot be a pixel gate — the
selection uuid is the attach signal.
