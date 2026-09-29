export {};

declare global {
  interface EmscriptenFS {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string, opts?: { encoding?: "binary" | "utf8" }): unknown;
    analyzePath(path: string): { exists: boolean };
    unlink(path: string): void;
  }

  // Loose shape of the wxWidgets-WASM element registry exposed by wx.js.
  interface WxElementInfo {
    id: string;
    typeName: string;
    name: string;
    label: string;
    visible: boolean;
    enabled: boolean;
    screenX: number;
    screenY: number;
    centerX: number;
    centerY: number;
    width: number;
    height: number;
    /** Parent window id (its pointer as a string), null for top-level. */
    parentId?: string | null;
  }

  /**
   * An owner-drawn item (toolbar tool, AUI part, grid cell, tab…) registered by
   * `wxWasmTrackElement`. Coordinates are relative to `#canvas` in CSS px (add
   * `#canvas.getBoundingClientRect()` for page coordinates, as wx.js does).
   */
  interface WxRenderedElementInfo {
    id: string;
    /** Owning window id — a key of the window registry (`elements`). */
    parentId: string;
    elementType: string;
    subType: string;
    label: string;
    tooltip: string;
    screenX: number;
    screenY: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    enabled: boolean;
    index: number;
    /** The item's own id when the paint site passed one (toolbar tool id). */
    userId?: number;
  }

  interface WxRenderedFilter {
    enabled?: boolean;
    elementType?: string;
    subType?: string;
    parentId?: string;
    label?: string;
  }

  interface WxElementRegistry {
    /** Window registry, keyed by window id. */
    elements?: Map<string, WxElementInfo>;
    /** Bumped on every window register/update/unregister. */
    version?: number;
    /** Bumped on every rendered-element change. */
    renderedVersion?: number;
    findAllRendered?(filter?: WxRenderedFilter): WxRenderedElementInfo[];
    findRenderedByParent?(parentId: string, options?: WxRenderedFilter): WxRenderedElementInfo[];
    findAll(filter?: {
      visible?: boolean;
      enabled?: boolean;
      type?: string;
      label?: string;
      name?: string;
    }): WxElementInfo[];
    findByLabel(label: string, options?: Record<string, unknown>): WxElementInfo[];
    findRenderedByLabel?(
      label: string,
      options?: Record<string, unknown>,
    ): WxElementInfo[];
  }

  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Module?: any;
    FS?: EmscriptenFS;
    wxElementRegistry?: WxElementRegistry;
    kicadWebOpenTool?: (toolName: string, fileName: string) => boolean;
    /** wx wasm port → page: the app's main frame was destroyed (File→Quit). */
    wxAppTopWindowClosed?: () => void;
    /** File System Access API (Chromium): writable local-folder sessions. */
    showDirectoryPicker?(options?: {
      mode?: "read" | "readwrite";
      id?: string;
    }): Promise<FileSystemDirectoryHandle>;
  }

  // The browsing-context window the tool runs in — now the top-level `window`
  // (the WASM boots in-document, not in an iframe). The Window interface PLUS the
  // global declarations (console, PointerEvent, document, …) that live on
  // `typeof globalThis`, not on the bare Window interface.
  type ToolWindow = Window & typeof globalThis;
}
