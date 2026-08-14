# wxWidgets WASM Test Status

> Mechanism note: everything below predates the 2026-08 JSPI migration; "Asyncify" rows describe the retired backend.

Last updated: 2025-12-04

## Test Summary

**All core Playwright tests pass**

| Category | Status | Notes |
|----------|--------|-------|
| Main App Load | WORKS | minimal_test.html loads and renders correctly |
| Standalone Apps | WORKS | 38 standalone test apps (244 total tests passing) |
| wxGrid | WORKS | Grid renders with cells, labels, and event handling |
| wxTreeCtrl | WORKS | Tree renders with expand/collapse, selection, add/delete items |
| wxTimer | WORKS | Timer start/stop/interval all functional |
| wxDialog | WORKS | Modal dialogs render correctly with Asyncify |
| wxDataViewCtrl | WORKS | List and tree views for Zone Manager, Net Inspector |
| wxHtmlWindow | WORKS | HTML rendering for About dialogs, error formatting |
| wxStyledTextCtrl | WORKS | Syntax highlighting for DRC rules, Python console |
| wxPrinting | WORKS | Print preview, print dialog, browser print via window.print() |
| wxDragDrop | WORKS | HTML5 file drop support for external files |
| wxPropertyGrid | WORKS | Property panels with categories, types, events |
| wxColourPickerCtrl | WORKS | Color pickers for layer colors |
| wxFontPickerCtrl | WORKS | Font pickers for text preferences |
| wxCollapsiblePane | WORKS | Expandable/collapsible property sections |
| wxListCtrl (virtual) | WORKS | Virtual mode for 10000+ item lists |
| wxInfoBar | WORKS | Notification bar for messages and warnings |
| wxDataViewCtrl (virtual) | WORKS | Virtual mode for 10,000+ items in Zone Manager/Net Inspector |
| wxAuiNotebook | WORKS | Closeable, reorderable tabbed panels |
| wxWizard | WORKS | Step-by-step dialog for Footprint Wizard |
| wxGrid cell editing | WORKS | Full editing support with text, number, choice, checkbox |
| wxCalendarCtrl | WORKS | Date selection with navigation |
| wxGrid cell renderers | WORKS | Custom color swatches, icon+text, striped rows |
| wxPrintPreview | WORKS | Print preview frame with zoom, navigation |
| wxBitmapButton | WORKS | Toolbar buttons with custom icons |
| wxTreebook | WORKS | Hierarchical settings pages |
| wxBitmapComboBox | WORKS | Dropdown with color swatch icons |
| wxCheckListBox | WORKS | List with checkboxes for layer visibility |
| wxValidator | WORKS | Input validation (text, integer, floating point, custom) |
| wxOwnerDrawnComboBox | WORKS | Custom dropdown rendering (layer selectors, font choosers) |
| wxPopupWindow | WORKS | Transient popups (toolbar palettes, color pickers) |
| wxXmlDocument | WORKS | XML parsing for config/project files (665 KiCad occurrences) |

---

## KiCad wxWidgets Usage Coverage

This section maps KiCad's wxWidgets usage to our test coverage.

### Critical for KiCad - WORKING

| KiCad Feature | wxWidgets Class | Test Status | Evidence |
|---------------|-----------------|-------------|----------|
| Main window frame | wxFrame | WORKS | All apps show frame with title |
| Menu bar (File, Edit, etc.) | wxMenuBar | WORKS | menu-03-file-clicked.png shows dropdown |
| Toolbars | wxToolBar | WORKS | toolbar-01-loaded.png shows icons |
| Status bar (coords, zoom) | wxStatusBar | WORKS | 3-field status bar like KiCad |
| Dockable panels | wxAuiManager | WORKS | aui-01-loaded.png shows Properties/Layers/Messages |
| Tab panels | wxNotebook | WORKS | 7 tabs switching correctly |
| Property editor panels | wxSplitterWindow | WORKS | layout-01-loaded.png shows split panes |
| Scrollable content | wxScrolledWindow | WORKS | 20 items scrollable in each pane |
| OpenGL canvas | wxGLCanvas | WORKS | covered by gal-webgl tests (WebGL GAL) |
| OpenGL context | wxGLContext | WORKS | covered by gal-webgl tests (WebGL GAL) |
| Drawing/painting | wxDC | WORKS | 08-drawing-done.png shows strokes |
| Mouse events | wxMouseEvent | WORKS | Drawing strokes captured |

### Controls - WORKING

| KiCad Use | wxWidgets Class | Test Status | Evidence |
|-----------|-----------------|-------------|----------|
| Action buttons | wxButton | WORKS | "Click Me" button functional |
| Toggle tools | wxToggleButton | WORKS | Toggle button in Controls tab |
| Options | wxCheckBox | WORKS | "Enable feature" checkbox |
| Selection groups | wxRadioButton | WORKS | Option A/B/C working |
| Value adjustment | wxSlider | WORKS | Slider draggable |
| Progress display | wxGauge | WORKS | Gauge renders |
| Numeric input | wxSpinCtrl | WORKS | spinctrl-01-visible.png shows control |
| Search fields | wxSearchCtrl | WORKS | Search field with placeholder |
| Item lists | wxListBox | WORKS | Item selection with highlight |
| Dropdowns | wxChoice | WORKS | 10a-choice-dropdown-open.png shows popup |
| Editable dropdowns | wxComboBox | WORKS | Visible in Text Input tab |

### Text Input - WORKING

| KiCad Use | wxWidgets Class | Test Status | Evidence |
|-----------|-----------------|-------------|----------|
| Single-line entry | wxTextCtrl | WORKS | Text input accepts typing |
| Multi-line entry | wxTextCtrl (multiline) | WORKS | Line 1/2/3 typed successfully |
| Password fields | wxTextCtrl (password) | WORKS | Password field visible |

### OpenGL Rendering

KiCad renders through the WebGL GAL path; see `gal-webgl.spec.ts` (26 scenarios).
The legacy-GL-emulation tests (immediate mode via -sLEGACY_GL_EMULATION and
gl_immediate_shim.js) were removed 2026-06-10 along with minimal_test's OpenGL tab.

### File Operations - PARTIAL

| KiCad Use | wxWidgets Class | Test Status | Notes |
|-----------|-----------------|-------------|-------|
| Open file dialog | wxFileDialog (FD_OPEN) | PARTIAL | Dialog events fire, browser file picker |
| Save file dialog | wxFileDialog (FD_SAVE) | PARTIAL | Dialog events fire, browser file picker |
| Multiple file selection | wxFileDialog (FD_MULTIPLE) | PARTIAL | Events fire |

---

## Previously BROKEN Features (Now Fixed)

### wxTreeCtrl - WORKS ✓
- **Status**: Tree control fully functional with expand/collapse, selection, add/delete
- **KiCad Impact**: HIGH - KiCad uses wxTreeCtrl for hierarchy browsers, component trees
- **Evidence**: tree-01-loaded.png shows tree with KiCad-like hierarchy
- **Fix**: Added null guard in LogEvent() - events fired before m_log was initialized

### wxMessageBox/wxDialog - WORKING ✓
- **Status**: Modal dialogs render correctly with Asyncify
- **KiCad Impact**: MEDIUM - Alert messages, confirmations
- **Evidence**: dialog-02-info-clicked.png shows Info dialog with icon, title, message, OK button
- **Fix**: Enabled Asyncify in build flags (`-sASYNCIFY=1 -sASYNCIFY_IMPORTS=['startModal']`)
- **Details**: ShowModal() now properly blocks until user closes dialog

### wxClipboard - WORKS ✓
- **Status**: Full clipboard support via browser Clipboard API with Asyncify
- **KiCad Impact**: MEDIUM - Copy/paste operations
- **Evidence**: clipboard-03-copy-clicked.png shows successful copy, all 6 clipboard tests pass
- **Fix**: Implemented browser Clipboard API integration with Asyncify for async-to-sync bridging
- **Details**: Added `js_writeTextToClipboard`, `js_readTextFromClipboard`, `js_clipboardHasText`, `js_clearClipboard` to ASYNCIFY_IMPORTS

### wxDataViewCtrl - WORKS ✓
- **Status**: Both wxDataViewListCtrl and wxDataViewTreeCtrl fully functional
- **KiCad Impact**: CRITICAL - Zone Manager, Net Inspector, Symbol/Footprint library browsers
- **Evidence**: dataview-01-loaded.png shows list with columns, dataview-02-tree-tab.png shows hierarchical tree
- **Tests**: 10/10 pass - List rendering, tree expand/collapse, tab switching, column headers
- **Details**: Test app mimics KiCad Zone Manager with zone data (name, net, priority, layer)

### wxHtmlWindow - WORKS ✓
- **Status**: HTML rendering works including tables, styled text, and scrolling
- **KiCad Impact**: MEDIUM - About dialogs, error message formatting, help content
- **Evidence**: htmlwin-01-loaded.png shows HTML rendering, htmlwin-04-about.png shows KiCad-style About dialog
- **Tests**: 8/8 pass - Basic HTML, tables, long content scrolling, KiCad About dialog
- **Details**: Test app demonstrates HTML features used in KiCad dialogs

### wxStyledTextCtrl (Scintilla) - WORKS ✓
- **Status**: Syntax highlighting, line numbers, code folding all functional
- **KiCad Impact**: MEDIUM - DRC rules editor, Python console, custom script editors
- **Evidence**: stc-01-loaded.png shows Python syntax highlighting with colors
- **Tests**: 10/10 pass - Python lexer, DRC Rules lexer, plain text, line numbers toggle, fold all
- **Details**: Test app demonstrates Python and DRC rules syntax highlighting like KiCad uses

### wxPrinting - WORKS ✓
- **Status**: Print preview, print dialog, page setup, and browser print all functional
- **KiCad Impact**: MEDIUM - Schematic and PCB printing
- **Evidence**: print-01-loaded.png shows print test app, print-04-preview-clicked.png shows preview frame
- **Tests**: 8/8 pass - App load, preview, print dialog, browser print, page setup, callbacks
- **Details**:
  - wxPrintout callbacks all fire correctly (OnBeginPrinting, OnPrintPage, OnEndDocument, etc.)
  - wxPrintPreview opens and renders preview frame
  - wxPrinter::Print() shows print dialog
  - Browser Print triggers `window.print()` for native browser print dialog
  - Page Setup dialog works with margins configuration

### wxDragDrop (HTML5 File Drop) - WORKS ✓
- **Status**: External file drops via HTML5 drag and drop API fully functional
- **KiCad Impact**: HIGH - Loading projects, schematics, PCBs via file drops
- **Evidence**: dnd-01-loaded.png shows test app, dnd-05-drop.png shows file drop processing
- **Tests**: 9/9 pass - App load, handlers registered, dragenter, dragleave, drop, file write, event fire
- **Details**:
  - HTML5 drag/drop events (dragenter, dragleave, drop) captured on canvas
  - Files read via `File.arrayBuffer()` and written to WASM `/tmp/` filesystem
  - wxDropFilesEvent dispatched to target window via C++ callback
  - Multiple file drops supported
  - KiCad file types (.kicad_pcb, .kicad_sch, .kicad_pro, etc.) work correctly

---

## Standalone Test Apps

Organized in `apps/standalone/` folders:

| App | Status | Tests | KiCad Relevance |
|-----|--------|-------|-----------------|
| menu/menu_test | WORKS | 5/5 | Menu system |
| toolbar/toolbar_test | WORKS | 6/6 | Tool palettes |
| layout/layout_test | WORKS | 5/5 | Split panel layout |
| aui/aui_test | WORKS | 5/5 | Dockable panels |
| clipboard/clipboard_test | WORKS | 6/6 | Copy/paste |
| filedialog/filedialog_test | WORKS | 5/5 | Open/save dialogs |
| grid/grid_test | WORKS | 2/2 | Property grids |
| dialog/dialog_test | WORKS | 5/5 | Alerts/confirmations |
| timer/timer_test | WORKS | 4/4 | Auto-save, animations |
| tree/tree_test | WORKS | 7/7 | Hierarchy browsers |
| dataview/dataview_test | WORKS | 10/10 | Zone Manager, Net Inspector |
| htmlwin/htmlwin_test | WORKS | 8/8 | About dialogs, error formatting |
| stc/stc_test | WORKS | 10/10 | DRC rules editor, Python console |
| print/print_test | WORKS | 8/8 | Schematic/PCB printing |
| dnd/dnd_test | WORKS | 9/9 | External file drop support |
| propgrid/propgrid_test | WORKS | 4/4 | Property panels (KiCad property editor) |
| pickers/pickers_test | WORKS | 4/4 | Color/font pickers (layer colors) |
| collapsible/collapsible_test | WORKS | 5/5 | Collapsible sections (property groups) |
| listctrl/listctrl_test | WORKS | 5/5 | Virtual list (large component lists) |
| infobar/infobar_test | WORKS | 5/5 | Notification bar (DRC messages) |
| gridrenderers/gridrenderers_test | WORKS | 5/5 | Custom cell renderers (color swatches, icons) |
| printpreview/printpreview_test | WORKS | 5/5 | Print preview frame, page setup |
| bitmapbuttons/bitmapbuttons_test | WORKS | 7/7 | Toolbar buttons, toggle state |
| specialized/specialized_test | WORKS | 8/8 | Treebook, BitmapComboBox, layer list |
| validators/validators_test | WORKS | 6/6 | Input validation (KiCad dialog validators) |
| ownerdrawn/ownerdrawn_test | WORKS | 5/5 | Custom dropdown rendering (layer selectors) |
| popup/popup_test | WORKS | 6/6 | Transient popups (toolbar palettes) |
| xml/xml_test | WORKS | 6/6 | XML parsing (config/project files) |
| wasmedge/wasmedge_test | WORKS | 8/8 | WASM edge cases (file system, threading, fonts) |
| fontenum/fontenum_test | WORKS | 1/1 | Font enumeration via Local Font Access API |
| textdecor/textdecor_test | WORKS | 1/1 | Text underline/strikethrough decorations |
| bitmask/bitmask_test | WORKS | 1/1 | Bitmap masking with wxMask transparency |
| regions/regions_test | WORKS | 1/1 | Non-rectangular region clipping |
| secondary-glcanvas/secondary-glcanvas_test | WORKS | 1/1 | Secondary-window wxGLCanvas is z-lifted above the window chrome (3D-viewer occlusion regression) |

---

## Main App Test Coverage

### Controls Tab
- wxButton: Click events logged
- wxToggleButton: Toggle state changes
- wxCheckBox: Check/uncheck works
- wxRadioButton: Selection switches between options
- wxSlider: Value changes on drag
- wxGauge: Renders progress bar

### Text Input Tab
- Single-line wxTextCtrl: Keyboard input works
- Multi-line wxTextCtrl: Multiple lines typed
- Password wxTextCtrl: Masked input
- wxComboBox: Editable dropdown

### Drawing Tab
- Mouse down/up events captured
- Line strokes drawn on wxPanel
- Clear Canvas button works
- wxDC drawing operations functional

### Lists Tab
- wxListBox: Item selection with blue highlight
- Add/Remove buttons functional
- wxChoice: Dropdown opens with items (Red, Green, Blue, Yellow, Purple)

- Vertex arrays: Working
- Matrix operations: Working
- State management: Working
- Texture coordinates: Working

### Grid Tab
- wxSpinCtrl: Renders with up/down arrows
- wxSearchCtrl: Renders with search icon and clear button
- wxGrid: WORKS - Grid renders with cells, labels, and event handling

### Dialogs Tab
- wxMessageBox: Info, Yes/No, Error dialogs render with icons and buttons
- wxDialog: Custom dialogs render with title bar, content, OK/Cancel buttons
- wxTimer: Start/Stop buttons, counter display
- **Working**: Modal dialogs block and wait for user input via Asyncify

---

## KiCad Readiness Assessment

### Ready for KiCad
1. Window management (wxFrame, wxMenuBar, wxToolBar, wxStatusBar)
2. Panel docking (wxAuiManager)
3. Layout controls (wxSplitterWindow, wxScrolledWindow, wxNotebook)
4. Basic controls (buttons, checkboxes, radio buttons, sliders)
5. Text input (single/multi-line)
6. List controls (wxListBox, wxChoice, wxComboBox)
7. Drawing/painting (wxDC, mouse events)
8. **wxMessageBox/wxDialog** - Modal dialogs with Asyncify
9. **wxGrid** - Property grids with cells, labels, and events
10. **wxTreeCtrl** - Hierarchy browsers with expand/collapse, selection, add/delete
11. **wxClipboard** - Copy/paste via browser Clipboard API with Asyncify
12. **wxDataViewCtrl** - Zone Manager, Net Inspector, Library browsers
13. **wxHtmlWindow** - About dialogs, error message formatting
14. **wxStyledTextCtrl** - DRC rules editor, Python console, script editors
15. **wxPrinting** - Print preview, print dialog, browser print via window.print()
16. **wxDragDrop** - External file drops via HTML5 drag and drop API
17. **wxPropertyGrid** - Property panels with categories, various property types
18. **wxPropertyGridManager** - Multi-page property organization
19. **wxColourPickerCtrl** - Color pickers for layer colors
20. **wxFontPickerCtrl** - Font pickers for text preferences
21. **wxCollapsiblePane** - Expandable/collapsible property sections
22. **wxListCtrl (virtual)** - Virtual mode for 10000+ item lists
23. **wxInfoBar** - Notification bar for DRC messages, warnings
24. **wxDataViewCtrl (virtual)** - Virtual mode for 10,000+ items (Zone Manager, Net Inspector)
25. **wxAuiNotebook** - Closeable, reorderable tabbed panels
26. **wxWizard** - Step-by-step Footprint Wizard dialog
27. **wxGrid cell editing** - Full editing with text, number, choice, checkbox editors
28. **wxCalendarCtrl** - Date picker with month/year navigation
29. **wxGrid custom renderers** - Color swatches, icon+text, striped rows for layer manager
30. **wxPrintPreview frame** - Print preview with zoom, page navigation
31. **wxBitmapButton** - Toolbar buttons with custom bitmap icons
32. **wxTreebook** - Hierarchical settings pages (General, Display>Colors, etc.)
33. **wxBitmapComboBox** - Layer chooser dropdown with color swatch icons
34. **wxCheckListBox** - Layer visibility list with checkboxes
35. **wxValidator** - Input validation (text, integer, float, custom validators)
36. **wxOwnerDrawnComboBox** - Custom dropdown rendering (layer selectors, font choosers)
37. **wxPopupWindow** - Transient popups (toolbar palettes, color pickers)
38. **wxXmlDocument** - XML parsing for config and project files
39. **wxFontEnumerator** - Font enumeration via Local Font Access API (Chrome 103+)
40. **wxMask (bitmap masking)** - Color-keyed transparency for toolbar icons
41. **Text decorations** - Underline/strikethrough in wxDC text rendering
42. **wxRegion clipping** - Non-rectangular clipping for complex shapes

### All KiCad-Critical Features Tested

All previously untested features have now been implemented and tested:

| Feature | KiCad Usage | Priority | Status |
|---------|-------------|----------|--------|
| wxDataViewCtrl virtual mode | Zone Manager, Net Inspector (large data) | HIGH | ✓ TESTED |
| wxAuiNotebook | Tab panels (variant) | MEDIUM | ✓ TESTED |
| wxWizard | Footprint wizard | MEDIUM | ✓ TESTED |
| wxGrid cell editing | Property editing | MEDIUM | ✓ TESTED |
| wxCalendarCtrl | Date selection | LOW | ✓ TESTED |
| wxGrid custom renderers | Layer manager color swatches | HIGH | ✓ TESTED |
| wxPrintPreview frame | Schematic/PCB print preview | MEDIUM | ✓ TESTED |
| wxBitmapButton | Toolbar icons | MEDIUM | ✓ TESTED |
| wxTreebook | Settings dialogs (hierarchical) | MEDIUM | ✓ TESTED |
| wxBitmapComboBox | Layer chooser with swatches | MEDIUM | ✓ TESTED |
| wxCheckListBox | Layer visibility toggles | MEDIUM | ✓ TESTED |

**Current Coverage**: ~100% of KiCad-critical features tested (244 tests across 38 apps)

### Not Needed for KiCad
1. wxRichTextCtrl - Disabled in WASM build, KiCad doesn't use it
2. wxGraphicsContext - KiCad uses OpenGL GAL directly, not wxGraphicsContext

---

## WASM Implementation Limitations

Some wxWidgets features have incomplete WASM implementations. These are documented below with their current status.

### Known WASM Limitations

| Feature | Status | Details |
|---------|--------|---------|
| wxGraphicsContext | NOT NEEDED | KiCad uses OpenGL GAL directly (via WebGL in WASM) |
| Threading (wxThread) | STUBBED | WASM is single-threaded, API exists but no-op |
| wxFileName::GetSize | STUBBED | Returns wxInvalidSize for virtual filesystem |

### Recently Implemented WASM Features

These features were implemented to improve KiCad compatibility:

| Feature | Status | Implementation Notes |
|---------|--------|----------------------|
| wxFontEnumerator | WORKS | Uses Local Font Access API (Chrome 103+) with Asyncify |
| Bitmap masking | WORKS | wxMask with color-keyed transparency via Canvas composite ops |
| Text decorations | WORKS | Underline/strikethrough via Canvas textDecoration property |
| Non-rectangular regions | WORKS | wxRegion clipping via Canvas path-based clip() with multiple rects |

### WASM Edge Cases Tested

The `wasmedge_test` app verifies WASM-specific behaviors:

- **File System**: `/tmp/` virtual filesystem read/write works
- **Threading**: wxUSE_THREADS defined but stubbed (expected)
- **Font Enumeration**: Works via Local Font Access API (Chrome 103+)
- **Clipboard**: Works via Asyncify browser integration
- **Memory Growth**: WASM memory growth works (10MB+ allocations)
- **OS Info**: wxGetOsVersion returns stubbed values (expected)
- **URL Launch**: wxLaunchDefaultBrowser works via window.open()
- **wxFileName**: Path manipulation functions work correctly

---

## Build Notes

### GL vs Non-GL Apps
- All wx test apps (including minimal_test) link with `LDFLAGS_NOGL`; legacy GL
  emulation was removed 2026-06-10. WebGL rendering is tested by gal-webgl.

### Build Command
Always use the build script:
```bash
cd tests/apps && ./build-test-apps.sh
```

---

## Baseline Screenshots

The test suite captures raw PNGs during test runs for visual regression testing,
compared offline against committed per-engine baselines (the calibrated gate in
`tools/screenshots/`).

### Directory Structure

```
tests/
├── baseline-screenshots/
│   ├── chromium/            # Known-good references, Chromium render
│   └── firefox/             # Known-good references, Firefox render
├── test-results/
│   ├── chromium/            # Latest run's captures per engine
│   └── firefox/
└── screenshot-manifest.json  # Authoritative {name, engine} list
```

Specs write via `stableShot(page, 'name.png')` / `shotPath(page, 'name.png')`
(`e2e/utils/element-tracker.ts`) — the engine subdir is derived from the running
browser, so the same spec on two engines produces two independent captures.

### Comparing Screenshots

```bash
cd tests
npm run screenshots:check
```

This diffs `test-results/<engine>/` against `baseline-screenshots/<engine>/` with
per-engine calibrated noise floors and reports CHANGED / ADDED / REMOVED (removed
detection is driven by the manifest). On each main push, CI posts the same report
(triptych images labeled `[chromium]`/`[firefox]`) to Discord.

### Updating Baseline Screenshots

CI's Linux render is the source of truth — never copy local (Mac) renders into
the baselines. Promote from a CI run instead (churn-free: only meaningfully
changed images restage, and the manifest regenerates automatically):

```bash
cd tests
npm run screenshots:promote -- --run <ci-run-id>
git commit
```

### Running Tests with Screenshots

```bash
cd tests
npm test                    # setup + the full merged run (all CI projects)
npx playwright test --ui    # Interactive mode with screenshot preview
```

---

## Screenshots Reference

| Screenshot | Shows |
|------------|-------|
| 03-after-load.png | Controls tab with all widgets |
| 06-text-input-typed.png | Text input with typed content |
| 08-drawing-done.png | Drawing strokes on canvas |
| 09-lists-tab.png | ListBox and Choice controls |
| 10a-choice-dropdown-open.png | Dropdown menu open |
| aui-01-loaded.png | AUI dockable panels |
| menu-03-file-clicked.png | File menu dropdown |
| toolbar-01-loaded.png | Toolbar with icons |
| layout-01-loaded.png | Splitter window |
| spinctrl-01-visible.png | SpinCtrl and SearchCtrl |
| wxgrid-dedicated-page.png | wxGrid with cells, labels, and data |
| dialog-02-info-clicked.png | Info dialog with icon, message, OK button |
| dialog-03-yesno-clicked.png | Yes/No/Cancel confirmation dialog |
| dialogs-custom-open.png | Custom wxDialog modal |
| dataview-01-loaded.png | wxDataViewListCtrl with zone data |
| dataview-02-tree-tab.png | wxDataViewTreeCtrl with hierarchical data |
| htmlwin-01-loaded.png | wxHtmlWindow with basic HTML |
| htmlwin-04-about.png | KiCad-style About dialog |
| stc-01-loaded.png | wxStyledTextCtrl with Python syntax highlighting |
| stc-03-drc-mode.png | DRC rules syntax highlighting |
| fontenum.png | Font enumeration via Local Font Access API |
| textdecor.png | Text decorations (underline, strikethrough, combined) |
| bitmask.png | Bitmap masking with wxMask color-keyed transparency |
| regions.png | Non-rectangular region clipping (union, subtract, complex shapes) |
