export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3050";

// Where the KiCad WASM artifacts are served from (no trailing slash).
//   dev / same-origin: "/wasm" (flat layout, served from public/wasm by Vite).
//   prod CDN:          VITE_WASM_ROOT, e.g. "https://cdn.pcbjam.com/wasm".
// A cross-origin CDN works because boot.ts loads the pthread worker through a
// same-origin blob shim (see wasm/boot.ts) and the CDN sets CORP/ACAO.
// VITE_WASM_ASSET_BASE_URL is the legacy name and is still honored.
export const WASM_ROOT = (
  import.meta.env.VITE_WASM_ROOT ??
  import.meta.env.VITE_WASM_ASSET_BASE_URL ??
  "/wasm"
).replace(/\/+$/, "");

// Per-release WASM manifest file under WASM_ROOT (e.g. "manifest-2.7.7.json").
// When set, the standalone resolves each tool's versioned, content-addressed
// folder (WASM_ROOT/<tool>/<ver>/) from it AT RUNTIME — see wasm/wasm-assets.ts,
// so a tool can be repointed after a bad deploy without rebuilding the app.
// Unset ⇒ flat layout directly under WASM_ROOT (dev / same-origin). The manifest
// is fetched uncached; the tool folders it points at are immutable + long-cached.
export const WASM_MANIFEST_FILE = import.meta.env.VITE_WASM_MANIFEST || null;

/** @deprecated Use WASM_ROOT + resolveWasmBase(). Kept for back-compat. */
export const WASM_ASSET_BASE_URL = WASM_ROOT;

// --- build identity (version badge + GPLv3 corresponding-source pointer) -------
// The standalone is GPLv3; the badge surfaces the build's tag + a link to the
// exact source. The repo commit pins the kicad + wxwidgets submodule revisions,
// so APP_GIT_SHA → github.com/.../commit/<sha> is our corresponding-source
// pointer (mirrors site/src/components/Footer.astro's BUILD_SHA). All three are
// injected at build time by scripts/deploy/build-demo.mjs; unset in a plain dev
// checkout (badge then shows "dev" → repo root).

/** Release tag for this build (e.g. "2.7.7"); shown in the version badge. */
export const APP_TAG = import.meta.env.VITE_APP_TAG || null;

/** Source commit this build was made from; the badge links to it as the GPLv3
 *  corresponding-source pointer. */
export const APP_GIT_SHA = import.meta.env.VITE_GIT_SHA || null;

/** Public source repository for the GPL editor (no trailing slash). */
export const REPO_URL = (
  import.meta.env.VITE_REPO_URL || "https://github.com/PCBJam/pcbjam"
).replace(/\/+$/, "");

/** Marketing / landing page (no trailing slash). The version badge links here so
 *  someone in the editor can reach the product page. */
export const LANDING_URL = (
  import.meta.env.VITE_LANDING_URL || "https://pcbjam.com"
).replace(/\/+$/, "");

/**
 * The companion management app's origin (no trailing slash), e.g.
 * "https://app.pcbjam.com". When set (the backed editor deploy), non-editor
 * surfaces — home, project overview, mgmt-only paths — redirect there; see
 * lib/redirect.ts (standalone-hardening 0006). Unset (dev / demo) keeps every
 * route local.
 */
export const APP_URL =
  (import.meta.env.VITE_APP_URL || "").replace(/\/+$/, "") || null;

/**
 * Where the in-editor waitlist form POSTs. The demo is a fully static deploy with
 * no backend, so it cross-posts to the landing site's serverless endpoint (which
 * sends CORS for this origin). Same JSON contract as site/src/pages/api/waitlist.ts.
 * Targets the canonical www host. The apex now serves the same Pages project
 * rather than redirecting, so either would work — but keep www: it is the
 * canonical host, and a CORS preflight cannot follow a redirect, so pointing at
 * a host that might ever redirect is a latent breakage.
 */
export const WAITLIST_URL =
  import.meta.env.VITE_WAITLIST_URL || "https://www.pcbjam.com/api/waitlist";

/**
 * Plausible analytics (privacy-friendly, cookieless). Off unless a script URL is
 * set (plain dev/checkout stays untracked). `PLAUSIBLE_SRC` is the shared site's
 * pa-*.js script URL — the pa- id keys the dashboard, no data-domain needed.
 * Point it at a self-hosted/proxied copy — e.g. on cdn.pcbjam.com — if
 * plausible.io won't load under the demo's COEP `require-corp`. See main.tsx
 * for the injection.
 */
export const PLAUSIBLE_SRC = import.meta.env.VITE_PLAUSIBLE_SRC || null;

/**
 * Error tracking (Better Stack). Off unless a DSN is set, so a plain dev
 * checkout and any deploy that doesn't set the var report nothing.
 *
 * The DSN is in SENTRY wire format because Better Stack ingests that protocol —
 * we run the stock @sentry/browser SDK against their host. Named by role rather
 * than by vendor precisely because the two differ: `VITE_SENTRY_DSN` would
 * imply Sentry receives the data (it doesn't) and `VITE_BETTERSTACK_DSN` would
 * imply a Better Stack SDK (there isn't one). See lib/error-reporting.ts.
 *
 * Format: https://<application-token>@<ingesting-host>/<application-id>
 *
 * NOTE: this token ships in the client bundle and is public — that is inherent
 * to browser error reporting and true of Sentry's own DSNs. It is write-only
 * (it cannot read anything back), so the exposure is quota abuse, not data.
 */
export const ERRORS_DSN = import.meta.env.VITE_ERRORS_DSN || null;

/** Environment tag on reported errors. Deploys set it explicitly; a build that
 *  forgot to should be obvious in the dashboard rather than silently blending
 *  into production. */
export const ERRORS_ENV = import.meta.env.VITE_ERRORS_ENV || "development";

/**
 * Where the standalone reads PROJECTS from (env VITE_PROJECT_SOURCE):
 *   "remote" (default) — the @pcbjam/shared REST backend at API_BASE_URL.
 *   "static"           — a read-only example gallery published to a CDN as a
 *                        manifest + file bytes (no backend), e.g. the
 *                        demo.pcbjam.com gallery. Editor saves download to local.
 *                        Needs VITE_PROJECT_MANIFEST_URL. See lib/project-source.ts.
 */
export type ProjectSourceKind = "remote" | "static";
export const PROJECT_SOURCE_KIND: ProjectSourceKind =
  import.meta.env.VITE_PROJECT_SOURCE === "static" ? "static" : "remote";

/** Full URL of the static gallery manifest, e.g.
 *  "https://cdn.pcbjam.com/content/2.7.7/manifest.json". Required for "static". */
export const PROJECT_MANIFEST_URL = import.meta.env.VITE_PROJECT_MANIFEST_URL || null;

/**
 * When "idb", loaded folders import into a browser-local (IndexedDB) project
 * with its own /p/:slug URL — editable, persistent across visits, exported via
 * Download .zip / per-file — instead of the in-page File System Access flow.
 * The local store is layered (composite) alongside the configured remote/gallery
 * source. Off by default (plain dev keeps disk write-back); build-demo.mjs turns
 * it on for the demo. See lib/idb-project-store.ts + lib/project-source.ts.
 */
export const LOCAL_PROJECTS_ENABLED =
  import.meta.env.VITE_LOCAL_PROJECTS === "idb";

import { colorForUser, type PresenceUser } from "@pcbjam/shared";
import { sessionIdentity } from "@/lib/session-identity";
import type { ProviderConfig, ProviderKind } from "@/wasm/collab";
import { cdnLibsSource } from "@/wasm/libs/cdn-source";
import { cdnModelsSource, type Model3dSource } from "@/wasm/libs/models-source";
import { remoteLibsSource } from "@/wasm/libs/remote-source";
import { scopedLibsSource } from "@/wasm/libs/scoped-source";
import type { LibsSource } from "@/wasm/libs/source";
import {
  withSpikeWritableFpLib,
  withSpikeWritableLib,
} from "@/wasm/libs/spike-writable";
import { staticLibsSource } from "@/wasm/libs/static-source";
import {
  syncedLibsSource,
  syncedScopeLibsSource,
} from "@/wasm/libs/synced-source";

/**
 * Which Yjs collab provider this deployment uses (one active per env), and its
 * endpoint/token. Defaults to `broadcastchannel` so a vanilla checkout keeps
 * the cross-tab-only behavior with no backend. Built here at the composition
 * root and passed into `startKicadCollab`, so `wasm/collab` stays env-agnostic.
 */
export function yjsProviderConfig(): ProviderConfig {
  const kind = (import.meta.env.VITE_YJS_PROVIDER ?? "broadcastchannel") as ProviderKind;
  const token = import.meta.env.VITE_YJS_TOKEN;
  return {
    kind,
    endpoint: import.meta.env.VITE_YJS_ENDPOINT,
    params: token ? { token } : undefined,
  };
}

/**
 * Where a backend project's DOCUMENT content lives (per deployment, not per
 * route — /p/<project> URLs behave the same either way):
 *
 *   "api"  — file bytes are fetched from the REST backend and a user save is
 *            uploaded back to it (the Y.Doc, when collab is on, mirrors the file).
 *   "ydoc" — the collab room is the source of truth: when it holds the document
 *            it is materialized client-side (docToFile) instead of fetching the
 *            file, and saves stay in MEMFS (the provider persists the doc). The
 *            REST backend still serves project metadata + sibling files, and the
 *            file fetch remains the first-open fallback that seeds the room.
 */
export type DocSource = "api" | "ydoc";

export function docSourceConfig(): DocSource {
  return import.meta.env.VITE_DOC_SOURCE === "ydoc" ? "ydoc" : "api";
}

/**
 * Which library source backs the editor's symbol chooser (env `VITE_LIBS_SOURCE`):
 *   "remote" (default) — fetch from the backend at `API_BASE_URL` over the
 *                        shared contract (origins served by the registry, or the
 *                        GPL example backend).
 *   "synced"           — remote listing + per-lib r2-idb-sync stacks (IDB cache,
 *                        realtime peer updates + editor reload). Also switches
 *                        `libsSourceForLib` to the single-lib synced source.
 *   "static"           — built-in offline example symbols (no backend).
 *   "off"              — disable libs (empty sym-lib-table).
 */
/**
 * `?user=`/`?libowner=` identity overrides are honored only when the BUILD
 * opts in (VITE_ALLOW_USER_OVERRIDE=1 — dev servers and e2e harnesses set it);
 * production builds never do, so a user can't pick an arbitrary identity via
 * the URL (collab-presence 0009).
 */
const USER_OVERRIDE_ALLOWED =
  import.meta.env.VITE_ALLOW_USER_OVERRIDE === "1";

/**
 * The current user slug — sent on every request via USER_HEADER and doubling
 * as the personal scope slug. Precedence (collab-presence 0009):
 * `?user=`/`?libowner=` when the build allows overrides (e2e isolation) →
 * the authenticated session user (lib/session-identity.ts, resolved from
 * /api/me during tool boot) → `VITE_USER`/`VITE_LIBS_OWNER` → a stable local
 * default.
 */
export function userSlug(): string {
  if (USER_OVERRIDE_ALLOWED && typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search);
    const p = q.get("user") ?? q.get("libowner");
    if (p) return p;
  }
  const session = sessionIdentity();
  if (session) return session.slug;
  return (
    import.meta.env.VITE_USER ?? import.meta.env.VITE_LIBS_OWNER ?? "local-user"
  );
}

/**
 * The local user's presence identity (collab-presence 0001/0009): id is the
 * slug (session slug once /api/me resolves), name is the session display name
 * (or email) when the session identity is the active one, else the slug
 * verbatim; color is the deterministic palette hash — the live room replaces
 * it with the nth-in-room claim (presence.ts).
 */
export function presenceUser(): PresenceUser {
  const slug = userSlug();
  const session = sessionIdentity();
  const name = session && session.slug === slug ? session.name : slug;
  return { id: slug, name, color: colorForUser(slug) };
}

/** Author identity stamped onto comments. */
export interface CommentAuthor {
  /** Slug — the IDENTITY key (colors, "is this mine?"). Never a display name. */
  id: string;
  /** Display name; falls back to the slug when no session identity is loaded. */
  name: string;
  /** Only present for a real authenticated session. */
  email?: string;
}

/**
 * Who to attribute a new comment to. Same identity as `presenceUser()`, plus the
 * email, and kept separate because comments DENORMALIZE these at write time
 * (comments-wire.ts) whereas presence re-broadcasts them live.
 */
export function commentAuthor(): CommentAuthor {
  const slug = userSlug();
  const session = sessionIdentity();
  const mine = session && session.slug === slug ? session : null;
  return { id: slug, name: mine?.name ?? slug, email: mine?.email };
}

/**
 * DEV-TIME presence style tuner (collab-presence): VITE_PRESENCE_TUNER=1 mounts
 * a floating panel that live-patches the wasm overlay style
 * (kicadCollabSetStyle) — shapes, widths, alphas, label placement, palettes —
 * so we can pick the shipped look. Off (and tree-shaken) in normal builds.
 */
export const PRESENCE_TUNER_ENABLED = import.meta.env.VITE_PRESENCE_TUNER === "1";

/**
 * The active scope (first URL segment) for API calls. Mirrors how `userSlug()`
 * reads the URL, so the source layer scopes requests without threading scope
 * through every signature. Falls back to `?scope=` / `VITE_SCOPE` / the personal
 * scope (the user slug). Client-only scopes (e.g. `@local`) are routed by the
 * project source and never sent to a backend.
 */
export function currentScope(): string {
  if (typeof window !== "undefined") {
    const seg = window.location.pathname.split("/").filter(Boolean)[0];
    if (seg && seg !== "projects" && seg !== "libs") {
      return decodeURIComponent(seg);
    }
    const q = new URLSearchParams(window.location.search).get("scope");
    if (q) return q;
  }
  return import.meta.env.VITE_SCOPE ?? userSlug();
}

/** Full URL of the CDN libs top manifest (required for VITE_LIBS_SOURCE=cdn),
 *  e.g. https://cdn.pcbjam.com/libs/kicad/9.0.0/manifest.json. The full default
 *  KiCad symbol+footprint set, served read-only as version-pinned static origins
 *  (IDB-cached). See wasm/libs/cdn-source.ts + docs/features/r2-idb-sync. */
export const CDN_LIBS_MANIFEST_URL =
  import.meta.env.VITE_LIBS_MANIFEST_URL || null;

/** Full URL of the CDN 3D-models top manifest, e.g.
 *  https://cdn.pcbjam.com/libs/kicad-models/10.0.0/manifest.json. Bodies are
 *  fetched lazily per board (sparse layers) and cached in IDB — never bulk
 *  synced. Unset ⇒ the 3D viewer renders bare boards (no component models).
 *  See wasm/libs/models-source.ts + docs/features/3d-models. */
export const CDN_MODELS_MANIFEST_URL =
  import.meta.env.VITE_MODELS_MANIFEST_URL || null;

/** The 3D model source for a tool boot (null ⇒ models disabled). One instance
 *  per call — WasmTool keeps a single instance per boot like the libs source. */
export function modelsSourceConfig(): Model3dSource | null {
  return CDN_MODELS_MANIFEST_URL
    ? cdnModelsSource(CDN_MODELS_MANIFEST_URL)
    : null;
}

/** The boot payload's lib hand-over (see wasm/libs/synced-source.ts). */
export interface LibsBootPreload {
  libs: import("@/wasm/libs/synced-source").PreloadedLibDto[];
  stacks: Record<
    string,
    import("@pcbjam/shared").SyncStackDescriptor | null
  >;
}

export function libsSourceConfig(
  projectId?: string,
  preload?: LibsBootPreload,
): LibsSource | null {
  const kind = import.meta.env.VITE_LIBS_SOURCE ?? "remote";
  // "local" is the placeholder id for launches with no real backend project
  // (local folder, tool grid, lib-scoped open). It is NOT a project on the
  // backend, so don't send it as the project header — a registry server would
  // scope its lib resolution (project-pinned mirrors) to a non-existent project
  // and return nothing. Real backend projects pass their uuid and keep scoping.
  const project = projectId && projectId !== "local" ? projectId : undefined;
  const base =
    kind === "off"
      ? null
      : kind === "static"
        ? staticLibsSource()
        : kind === "cdn"
          ? CDN_LIBS_MANIFEST_URL
            ? cdnLibsSource(CDN_LIBS_MANIFEST_URL)
            : staticLibsSource() // misconfigured cdn ⇒ offline fallback
          : kind === "synced"
            ? // Remote listing + per-lib sync stacks (IDB cache, realtime,
              // editor reload on peer edits) — see syncedScopeLibsSource.
              syncedScopeLibsSource(
                remoteLibsSource(API_BASE_URL, currentScope(), userSlug(), project),
                {
                  apiBase: API_BASE_URL,
                  scope: currentScope(),
                  user: userSlug(),
                  project,
                  preloaded: preload,
                  log: (m) => console.log(m),
                },
              )
            : remoteLibsSource(API_BASE_URL, currentScope(), userSlug(), project);

  // 0004-A spike: `?libwrite=1` adds one in-memory writable user SYMBOL lib so the
  // editor save path works with no backend (a dev/test aid). The real remote
  // write path (0004-C) needs no flag — boot ensures a user lib via createLib.
  // 0009-S spike: `?fpwrite=1` does the same for a writable FOOTPRINT lib.
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("fpwrite") === "1") {
      return withSpikeWritableFpLib(base, (m) => console.log(m));
    }
    if (params.get("libwrite") === "1") {
      return withSpikeWritableLib(base, (m) => console.log(m));
    }
  }

  return base;
}

/**
 * The libs source for a single backend library opened scoped to itself
 * (`/l/<libId>/<tool>`). With `VITE_LIBS_SOURCE=synced` this is the r2-idb-sync
 * bridge (`syncedLibsSource`, per-lib IDB cache + realtime); otherwise it's the
 * existing per-item network path wrapped in `scopedLibsSource`. Falls back to the
 * network path when the lib can't be synced.
 */
export function libsSourceForLib(
  libId: string,
  projectId?: string,
): LibsSource | null {
  const project = projectId && projectId !== "local" ? projectId : undefined;
  if (import.meta.env.VITE_LIBS_SOURCE === "synced") {
    return syncedLibsSource(libId, {
      apiBase: API_BASE_URL,
      scope: currentScope(),
      user: userSlug(),
      project,
      log: (m) => console.log(m),
    });
  }
  const base = libsSourceConfig(projectId);
  return base ? scopedLibsSource(base, libId) : null;
}
