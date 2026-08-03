/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** WASM asset root, no trailing slash. Dev: "/wasm". Prod CDN: e.g. "https://cdn.pcbjam.com/wasm". */
  readonly VITE_WASM_ROOT?: string;
  /** Per-release WASM manifest file under VITE_WASM_ROOT (e.g. "manifest-2.7.7.json"); enables versioned per-tool folders. */
  readonly VITE_WASM_MANIFEST?: string;
  /** Release tag for this build (e.g. "2.7.7"); shown in the version badge. */
  readonly VITE_APP_TAG?: string;
  /** Source commit this build was made from; the badge links to it as the GPLv3 corresponding-source pointer. */
  readonly VITE_GIT_SHA?: string;
  /** Public source repo URL for the GPL editor (default github.com/PCBJam/pcbjam). */
  readonly VITE_REPO_URL?: string;
  /** @deprecated legacy alias for VITE_WASM_ROOT. */
  readonly VITE_WASM_ASSET_BASE_URL?: string;
  /** Project source: "remote" (default, REST backend) | "static" (read-only CDN gallery, no backend). */
  readonly VITE_PROJECT_SOURCE?: string;
  /** Static gallery manifest URL (required when VITE_PROJECT_SOURCE=static), e.g. https://cdn.pcbjam.com/content/2.7.7/manifest.json. */
  readonly VITE_PROJECT_MANIFEST_URL?: string;
  /** "idb" ⇒ loaded folders import into a browser-local (IndexedDB) project with its own URL; otherwise the in-page File System Access flow. */
  readonly VITE_LOCAL_PROJECTS?: string;
  /** Library source: "remote" (default backend) | "static" (offline examples) | "cdn" (full KiCad set from CDN static origins) | "synced" | "off". */
  readonly VITE_LIBS_SOURCE?: string;
  /** CDN libs top-manifest URL (required when VITE_LIBS_SOURCE=cdn), e.g. https://cdn.pcbjam.com/libs/kicad/9.0.0/manifest.json. */
  readonly VITE_LIBS_MANIFEST_URL?: string;
  /** Yjs collab provider: none | broadcastchannel | partykit | hocuspocus. */
  readonly VITE_YJS_PROVIDER?: string;
  /** Host/URL for network collab providers (partykit, hocuspocus). */
  readonly VITE_YJS_ENDPOINT?: string;
  /** Optional connection token for the collab provider. */
  readonly VITE_YJS_TOKEN?: string;
  /** Plausible pa-*.js script URL; unset ⇒ no tracking (dev default). */
  readonly VITE_PLAUSIBLE_SRC?: string;
  /** Error-tracking DSN (Sentry wire format, pointed at Better Stack); unset ⇒ no reporting (dev default). */
  readonly VITE_ERRORS_DSN?: string;
  /** Environment tag on reported errors: "production" | "demo" | "preview". Defaults to "development". */
  readonly VITE_ERRORS_ENV?: string;
  /** Management app origin (e.g. https://app.pcbjam.com); set ⇒ non-editor routes redirect there (lib/redirect.ts). */
  readonly VITE_APP_URL?: string;
  /** "1" ⇒ honor `?user=`/`?libowner=` identity overrides (dev/e2e harnesses only — NEVER production builds). */
  readonly VITE_ALLOW_USER_OVERRIDE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
