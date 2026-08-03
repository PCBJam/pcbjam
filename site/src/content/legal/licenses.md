---
title: Open-Source Licenses & Source Code
description: The open-source software PCBJam is built on, the licences that apply, and how to get the corresponding source code.
updated: 2026-08-03
---

## The short version (summary)

This summary helps you understand this page at a glance. It is **not a substitute** for the open-source licences themselves, which are what legally apply.

- **PCBJam runs open-source software in your browser.** The application is built on **KiCad** (the open-source EDA suite) compiled to WebAssembly, together with **wxWidgets** and other open-source libraries. Each stays under its own licence.
- **You have the right to the source.** Because we deliver GPL-licensed software (KiCad) to your browser, you are entitled under the GNU GPL to the **corresponding source code** for the version you receive. See [Getting the source code](#getting-the-source-code).
- **These licences are not changed by us.** Our [Terms of Service](/terms) govern the hosted PCBJam service and our own proprietary code; they do not modify or restrict your rights under the open-source licences with respect to the open-source components themselves.
- **Trademarks.** "KiCad" and related marks belong to their owners. PCBJam is an independent product built on KiCad and is **not affiliated with, endorsed by, or sponsored by** the KiCad project.

---

## Components and their licences

PCBJam is a combined work. The table below lists its principal open-source components and the licence that applies to each.

| Component | What it is | Licence |
|---|---|---|
| **KiCad** | EDA suite, compiled to WebAssembly — the core of PCBJam | **GNU General Public License, version 3 (GPLv3)** |
| **wxWidgets** (base) | Cross-platform GUI toolkit that KiCad uses | **wxWindows Library Licence v3.1** (LGPL v2+ with a binary-distribution exception) |
| **wxWidgets — WebAssembly port** | The browser/WASM platform layer, derived from [ahilss/wxWidgets-wasm](https://github.com/ahilss/wxWidgets-wasm) | **GNU Lesser General Public License, version 2 (LGPL v2)** — *without* the wxWindows binary exception |
| Other bundled libraries | Various supporting libraries used by KiCad | Their respective licences (Apache-2.0, MIT, BSD-3-Clause, Boost, CC0, ISC, CC-BY-SA-4.0, and others) |
| Browser application libraries | The JavaScript/TypeScript libraries the editor's own interface is built from — including React, Yjs (collaborative editing), Radix UI, and the Sentry SDK (used to report crashes to our error-tracking provider; see the [Privacy Policy](/privacy)) | Predominantly **MIT**, with some Apache-2.0 and BSD. Exact versions are pinned in `web/pnpm-lock.yaml` in the source repository |

The combined application is conveyed to you under the **GPLv3**. The wxWidgets components are GPL-compatible: the base toolkit's licence is explicitly compatible with GPL'd applications, and the LGPL v2 WebAssembly-port files may be combined into a GPLv3 work under the LGPL's terms.

> **Note on the WebAssembly port.** The wxWidgets WASM-port files (originally authored by Adam Hilss) are released under plain **LGPL v2 without** the wxWindows binary-distribution exception that the rest of wxWidgets grants. This does not affect your rights here — PCBJam is conveyed as open source under the GPLv3 regardless — but we state it so our notices are accurate. The unmodified wxWidgets base remains under the wxWindows Library Licence.

---

## Getting the source code

In line with the GNU GPL (and as referenced in §12.4 of our [Terms](/terms)), the complete **corresponding source code** for the GPL-licensed software we deliver to your browser — together with the applicable licence texts and notices — is publicly available in one place:

**<https://github.com/PCBJam/pcbjam>**

The KiCad and wxWidgets forks are included in that repository as **git submodules**, so a recursive clone fetches everything needed to build PCBJam:

```sh
git clone --recurse-submodules https://github.com/PCBJam/pcbjam.git
```

For reference, the component forks pulled in as submodules are:

- **KiCad fork** — <https://github.com/PCBJam/kicad-source-mirror> (branch `wasm-port`)
- **wxWidgets fork** (incl. the WebAssembly port) — <https://github.com/PCBJam/wxWidgets> (branch `wasm-port`)

The source corresponding to a specific deployed build is identified by the commit revisions — including submodule revisions — recorded in the application's **About / build information**. If you need the exact corresponding source for a build you received and cannot locate it, contact us at **hello@pcbjam.com** and we will provide it.

We do not claim ownership of, and do not purport to relicense, the open-source components.

---

## Full licence texts

- **GNU General Public License v3 (GPLv3)** — <https://www.gnu.org/licenses/gpl-3.0.html>
- **GNU Lesser General Public License v2 (LGPL v2)** — <https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html>
- **wxWindows Library Licence v3.1** — <https://www.wxwidgets.org/about/licence/>

Copies of these licences and the per-component notices are also included in the source repositories listed above.
