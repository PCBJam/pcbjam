/*
 * Self-contained boot harness for the KiCad Gerber viewer (gerbview) WASM,
 * embedded in the landing page / blog post via an <iframe>. A faithful port of
 * the standalone React boot (web/standalone/src/wasm/boot.ts) — same global
 * `Module`, same preRun steps, same wx.js -> wx-dom.js -> gerbview.js order.
 *
 * Classic script (NOT a module): the non-modularized WASM glue reads a GLOBAL
 * `var Module` and a GLOBAL `mainWindow`, and publishes `FS` onto the global
 * scope. `window.Module = ...` is what makes the glue see our config.
 *
 * ── Assets come from the versioned CDN (cdn.pcbjam.com) — the SAME artifacts the
 * demo/app deploy publishes, not a hand-synced copy. We resolve gerbview's
 * immutable, content-addressed folder at runtime from the release manifest:
 *
 *     manifest-latest.json  -> { tag }
 *     manifest-<tag>.json   -> tools.gerbview -> <ver>
 *     base = <CDN_ROOT>/gerbview/<ver>
 *
 * so the landing always shows the LATEST deployed gerbview with no manual sync.
 * A tool folder is self-contained + ABI-matched: gerbview.wasm, gerbview.js,
 * wx.js, wx-dom.js, images.tar.gz. See docs/features/demo-deploy/0001-*.
 *
 * The folder is CROSS-ORIGIN to this page (which is COEP `require-corp`); the CDN
 * sends `Cross-Origin-Resource-Policy: cross-origin` + `Access-Control-Allow-Origin: *`
 * so the <script>/fetch loads are permitted. The one thing a cross-origin base
 * breaks is the pthread worker — `new Worker(<cross-origin URL>)` is a
 * SecurityError — so `mainScriptUrlOrBlob` is a SAME-ORIGIN `blob:` worker that
 * `importScripts()` the cross-origin glue (a blob URL inherits the page origin;
 * a classic worker's importScripts is allowed cross-origin under CORP).
 *
 * Dev overrides (query string): ?base=<folder> uses that folder verbatim (e.g. a
 * local build); ?tag=<tag> pins a specific release; ?cdn=<root> swaps the CDN root.
 */

(function () {
  "use strict";

  // Versioned WASM CDN root (no trailing slash). Overridable with ?cdn=.
  var CDN_ROOT = "https://cdn.pcbjam.com/wasm";

  var params = new URLSearchParams(location.search);

  // The ?base= / ?cdn= / ?tag= overrides choose where the WASM bootstrap scripts
  // are loaded from and are injected as classic <script src>, so they must be
  // honored in LOCAL DEVELOPMENT ONLY — a shipped page ignores them. This is a
  // static public/ asset (no `import.meta.env.DEV` substitution), so the check
  // is a runtime hostname test.
  var DEV_HOSTS = ["localhost", "127.0.0.1", "[::1]", "", "0.0.0.0"];
  function devParam(name) {
    return DEV_HOSTS.indexOf(location.hostname) !== -1 ? params.get(name) : null;
  }

  // KiCad paths baked into the WASM build (see web/standalone/src/wasm/constants.ts).
  // KICAD_VERSION_DIR MUST match the deployed build's GetMajorMinorVersion() — the
  // config we seed to suppress the first-run wizard is only read from THIS dir.
  // The KiCad 10.0.x rebase bumped it from "9.99" to "10.0"; bump it here if a
  // future deploy changes KiCad's major.minor.
  var KICAD_VERSION_DIR = "10.0";
  var KICAD_CONFIG_DIR =
    "/home/kicad/.config/kicad/kicad/" + KICAD_VERSION_DIR;
  var RESOURCE_PATH =
    "/workspace/build-wasm/sysroot/share/kicad/resources";

  // The board to auto-open: all tiny_tapeout layers (bottom→top for a sensible
  // draw order). The .gbrjob is preloaded too but we open the individual layer
  // files (gerbview opens gerber/drill files from argv deterministically).
  var BOARD_DIR = "/home/kicad/demo";
  var BOARD_FILES = [
    "tinytapeout-demo-Edge_Cuts.gbr",
    "tinytapeout-demo-B_Cu.gbr",
    "tinytapeout-demo-In2_Cu.gbr",
    "tinytapeout-demo-In1_Cu.gbr",
    "tinytapeout-demo-F_Cu.gbr",
    "tinytapeout-demo-B_Mask.gbr",
    "tinytapeout-demo-F_Mask.gbr",
    "tinytapeout-demo-B_Paste.gbr",
    "tinytapeout-demo-F_Paste.gbr",
    "tinytapeout-demo-B_Silkscreen.gbr",
    "tinytapeout-demo-F_Silkscreen.gbr",
    "tinytapeout-demo-User_2.gbr",
    "tinytapeout-demo-PTH.drl",
    "tinytapeout-demo-NPTH.drl",
    "tinytapeout-demo-job.gbrjob",
  ];
  var OPEN_FILES = BOARD_FILES.filter(function (f) {
    return /\.(gbr|drl)$/.test(f);
  });
  var OPEN_ARGS = OPEN_FILES.map(function (f) {
    return BOARD_DIR + "/" + f;
  });

  // ── Status UI ──────────────────────────────────────────────────────────────
  var statusText = document.getElementById("status-text");
  var progressBar = document.getElementById("progress-bar");
  function setStatusUI(text) {
    if (statusText) statusText.textContent = text;
    var m = /(\d+)\/(\d+)/.exec(text || "");
    if (m && progressBar) {
      progressBar.style.width =
        (parseInt(m[1], 10) / parseInt(m[2], 10)) * 100 + "%";
    }
  }
  function hideStatus() {
    var s = document.getElementById("status");
    if (s) s.style.display = "none";
  }
  function showError(msg) {
    console.error("[KICAD_ERROR] " + msg);
    if (statusText) {
      statusText.textContent = "Error: " + msg;
      statusText.style.color = "#ff6b6b";
    }
  }

  // The WASM reads the top frame geometry from a GLOBAL `mainWindow` element.
  var mainWindow = document.getElementById("main-window");
  window.mainWindow = mainWindow;

  // ── Resolve gerbview's versioned CDN folder from the release manifest ────────
  function fetchJson(url) {
    // manifest-*.json are served `no-store` so a rollback takes effect next load.
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.json();
    });
  }

  function resolveBase() {
    var override = devParam("base");
    if (override) return Promise.resolve(override.replace(/\/+$/, ""));
    var root = (devParam("cdn") || CDN_ROOT).replace(/\/+$/, "");
    var tagParam = devParam("tag");
    var tagP = tagParam
      ? Promise.resolve(tagParam)
      : fetchJson(root + "/manifest-latest.json").then(function (m) {
          if (!m || !m.tag) throw new Error("manifest-latest.json has no tag");
          return m.tag;
        });
    return tagP.then(function (tag) {
      return fetchJson(root + "/manifest-" + tag + ".json").then(function (m) {
        var ver = m && m.tools && m.tools.gerbview;
        if (!ver) throw new Error("no gerbview version in manifest-" + tag);
        console.log("[KICAD] gerbview " + ver + " (release " + tag + ")");
        return root + "/gerbview/" + ver;
      });
    });
  }

  // ── preRun steps ────────────────────────────────────────────────────────────
  function createCanvas() {
    var canvas = document.createElement("canvas");
    canvas.id = "canvas";
    canvas.style.display = "none";
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    canvas.oncontextmenu = function (e) {
      e.preventDefault();
    };
    canvas.addEventListener(
      "webglcontextlost",
      function (e) {
        showError("WebGL context lost — reload to retry.");
        e.preventDefault();
      },
      false
    );
    mainWindow.appendChild(canvas);
    Module.canvas = canvas;
    console.log("[KICAD] canvas " + window.innerWidth + "x" + window.innerHeight);
  }

  // Suppress the first-run setup wizard (its modal loop crashes Asyncify on our
  // ephemeral MEMFS): make every settings provider report NeedsUserInput()==false.
  function seedKicadConfig() {
    FS.mkdirTree(KICAD_CONFIG_DIR);
    var seed = function (path, contents) {
      if (FS.analyzePath(path).exists) return;
      FS.writeFile(path, contents);
    };
    seed(
      KICAD_CONFIG_DIR + "/kicad_common.json",
      JSON.stringify(
        {
          do_not_show_again: {
            update_check_prompt: true,
            data_collection_prompt: true,
          },
        },
        null,
        2
      )
    );
    seed(KICAD_CONFIG_DIR + "/sym-lib-table", "(sym_lib_table\n  (version 7)\n)\n");
    seed(KICAD_CONFIG_DIR + "/fp-lib-table", "(fp_lib_table\n  (version 7)\n)\n");
    seed(
      KICAD_CONFIG_DIR + "/design-block-lib-table",
      "(design_block_lib_table\n  (version 7)\n)\n"
    );
    console.log("[KICAD] seeded config (wizard suppressed)");
  }

  // Boot the tool once its CDN folder is resolved. `base` is the (cross-origin)
  // versioned folder; every asset — glue, wasm, images.tar.gz — lives under it.
  function boot(base) {
    // ── Prefetch the heavy, non-wasm assets in parallel with the wasm download ──
    // images.tar.gz (compiled-in KiCad resources) comes from the tool folder; the
    // board layers are same-origin fixtures. Both are far smaller than
    // gerbview.wasm, so they land before preRun runs; a run dependency guards the
    // rare case where the wasm wins the race.
    var resourceData = null;
    // The CDN stores images.tar.gz as raw gzip with NO Content-Encoding, so the
    // browser hands us the compressed bytes and KiCad's own gunzip succeeds.
    fetch(base + "/images.tar.gz")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        resourceData = new Uint8Array(buf);
        console.log("[KICAD] prefetched images.tar.gz (" + resourceData.length + " bytes)");
      })
      .catch(function (err) {
        console.warn("[KICAD] images.tar.gz prefetch failed:", err.message);
      });

    var boardData = null; // { name: Uint8Array }
    var boardPromise = Promise.all(
      BOARD_FILES.map(function (name) {
        return fetch("./board/" + name)
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status + " for " + name);
            return r.arrayBuffer();
          })
          .then(function (buf) {
            return [name, new Uint8Array(buf)];
          });
      })
    )
      .then(function (pairs) {
        boardData = {};
        pairs.forEach(function (p) {
          boardData[p[0]] = p[1];
        });
        console.log("[KICAD] prefetched " + pairs.length + " board files");
      })
      .catch(function (err) {
        console.error("[KICAD] board prefetch failed:", err.message);
      });

    function writeResources() {
      FS.mkdirTree(RESOURCE_PATH);
      if (resourceData) {
        FS.writeFile(RESOURCE_PATH + "/images.tar.gz", resourceData);
        console.log("[KICAD] wrote images.tar.gz");
      } else {
        console.warn("[KICAD] images.tar.gz not ready at preRun");
      }
    }

    // Write the board into MEMFS and point argv at it so gerbview auto-opens it.
    // argv must be set before main(); a run dependency keeps main() waiting if the
    // board fetch hasn't landed yet.
    function preloadBoard() {
      Module.arguments = OPEN_ARGS;
      var writeBoard = function () {
        if (!boardData) return;
        FS.mkdirTree(BOARD_DIR);
        Object.keys(boardData).forEach(function (name) {
          FS.writeFile(BOARD_DIR + "/" + name, boardData[name]);
        });
        console.log("[KICAD] wrote board into " + BOARD_DIR + "; argv=" + OPEN_ARGS.length + " files");
      };
      if (boardData) {
        writeBoard();
        return;
      }
      var add = window.addRunDependency;
      var rm = window.removeRunDependency;
      if (typeof add === "function" && typeof rm === "function") {
        add("board-files");
        boardPromise.then(function () {
          writeBoard();
          rm("board-files");
        });
      } else {
        // Best-effort fallback (board << wasm, so this path is unlikely to lose).
        boardPromise.then(writeBoard);
      }
    }

    // The pthread worker "script" for Module.mainScriptUrlOrBlob. KiCad spawns
    // CLASSIC workers via `new Worker(...)`; a cross-origin URL is a SecurityError,
    // so for the CDN base we hand emscripten a SAME-ORIGIN blob worker that
    // importScripts the cross-origin glue (allowed because the CDN sends CORP).
    // NOTE: this page tracks the CDN's LATEST deployed glue, not this repo's
    // build — emscripten 6 (the JSPI builds) ignores mainScriptUrlOrBlob, so
    // once such a release is deployed this becomes inert (cross-origin pthread
    // gap: docs/features/async/23-jspi-runtime.md in pcbjam-private).
    function pthreadWorkerScript() {
      var abs = new URL(base + "/gerbview.js", location.href);
      if (abs.origin === location.origin) return base + "/gerbview.js";
      return new Blob(["importScripts(" + JSON.stringify(abs.href) + ");"], {
        type: "text/javascript",
      });
    }

    // ── Module config (global) ─────────────────────────────────────────────────
    var Module = {
      thisProgram: "/usr/bin/gerbview", // argv[0] for KiCad's DEBUG check
      arguments: OPEN_ARGS,
      preRun: [createCanvas, writeResources, seedKicadConfig, preloadBoard],
      postRun: [],
      print: function () {
        console.log("[KICAD_OUT] " + Array.prototype.join.call(arguments, " "));
      },
      printErr: function () {
        console.error("[KICAD_ERR] " + Array.prototype.join.call(arguments, " "));
      },
      setStatus: function (text) {
        if (text) console.log("[KICAD_STATUS] " + text);
        setStatusUI(text);
      },
      totalDependencies: 0,
      monitorRunDependencies: function (left) {
        this.totalDependencies = Math.max(this.totalDependencies, left);
        Module.setStatus(
          left
            ? "Preparing… (" + (this.totalDependencies - left) + "/" + this.totalDependencies + ")"
            : "All downloads complete."
        );
      },
      onRuntimeInitialized: function () {
        console.log("[KICAD] runtime initialized");
        if (Module.canvas) Module.canvas.style.display = "block";
        hideStatus();
      },
      onAbort: function (what) {
        showError("aborted: " + (what === undefined ? "" : String(what)));
      },
      // Everything (the .wasm and the pthread worker's relative fetches) resolves
      // against the versioned CDN folder.
      locateFile: function (path) {
        return base + "/" + path;
      },
      // Pin the pthread worker: same-origin base → direct URL; cross-origin CDN →
      // a same-origin blob shim that importScripts the glue (see helper above).
      mainScriptUrlOrBlob: pthreadWorkerScript(),
    };
    window.Module = Module;

    Module.setStatus("Downloading…");
    window.onerror = function (msg, url, line) {
      showError(msg + " @ " + url + ":" + line);
      return false;
    };

    // ── Inject glue scripts in the required order ──────────────────────────────
    // wx.js → wx-dom.js → gerbview.js, all from the (cross-origin) CDN folder.
    loadScript(base + "/wx.js")
      .then(function () {
        return loadScript(base + "/wx-dom.js");
      })
      .then(function () {
        return loadScript(base + "/gerbview.js");
      })
      .then(function () {
        console.log("[KICAD] injected wx.js + wx-dom.js + gerbview.js (base=" + base + ")");
      })
      .catch(function (err) {
        showError(err.message);
      });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error("failed to load " + src));
      };
      document.body.appendChild(s);
    });
  }

  setStatusUI("Resolving latest build…");
  resolveBase()
    .then(boot)
    .catch(function (err) {
      showError("could not resolve gerbview build: " + err.message);
    });
})();
