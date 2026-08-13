import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Listener = { callback: (event: FakeEvent) => void; options?: unknown };

class FakeEvent {
  target: FakeElement;
  key = "";
  button = 0;
  buttons = 0;
  detail = 0;
  clientX = 0;
  clientY = 0;
  deltaY = 0;
  ctrlKey = false;
  shiftKey = false;
  altKey = false;
  metaKey = false;

  constructor(target: FakeElement) {
    this.target = target;
  }

  stopPropagation() {}
  preventDefault() {}
}

class FakeElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly classList = {
    add: (...names: string[]) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      names.forEach((name) => classes.add(name));
      this.className = [...classes].join(" ");
    },
  };
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  className = "";
  id = "";
  disabled = false;
  checked = false;
  selected = false;
  selectedIndex = 0;
  value = "";
  type = "";
  isContentEditable = false;
  offsetWidth = 120;
  offsetHeight = 24;
  offsetTop = 0;
  offsetLeft = 0;
  scrollHeight = 0;
  clientHeight = 0;
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent() {
    return this.text;
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children.forEach((child) => {
      child.parentNode = null;
      child.parentElement = null;
    });
    this.children = [];
  }

  get isConnected(): boolean {
    for (let current: FakeElement | null = this; current; current = current.parentNode) {
      if (current.tagName === "BODY" || current.tagName === "HEAD") return true;
    }
    return false;
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
    this.parentElement = null;
  }

  contains(target: FakeElement): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, callback: (event: FakeEvent) => void, options?: unknown) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, options });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, callback: (event: FakeEvent) => void) {
    this.listeners.set(type,
      (this.listeners.get(type) ?? []).filter((listener) => listener.callback !== callback));
  }

  fire(type: string, event = new FakeEvent(this)) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener.callback(event);
  }

  getBoundingClientRect() {
    if (!this.isConnected) {
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    const x = this.className === "wx-menu-title" ? 10 : 40;
    const y = this.className === "wx-menu-title" ? 10 : 50;
    const width = 120;
    const height = 20;
    return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height };
  }

  closest(selector: string): FakeElement | null {
    if (selector.startsWith(".") && this.className.split(/\s+/).includes(selector.slice(1)))
      return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelector(_selector: string): FakeElement | null {
    return null;
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  cloneNode() {
    const clone = new FakeElement(this.tagName);
    clone.className = this.className;
    Object.assign(clone.dataset, this.dataset);
    Object.assign(clone.style, this.style);
    return clone;
  }
}

class FakeDocument {
  readonly head = new FakeElement("head");
  readonly body = new FakeElement("body");
  readonly listeners = new Map<string, Listener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, callback: (event: FakeEvent) => void, options?: unknown) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, options });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, callback: (event: FakeEvent) => void) {
    this.listeners.set(type,
      (this.listeners.get(type) ?? []).filter((listener) => listener.callback !== callback));
  }

  getElementById(id: string): FakeElement | null {
    const visit = (node: FakeElement): FakeElement | null => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this.head) ?? visit(this.body);
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.length, 0);
  }
}

type FakeModule = Record<string, unknown> & {
  wxDiscardDomBrowserLifetime(): boolean;
  wxDiscardDomEventSnapshots(): void;
  wxDomEventSnapshotPendingBytes(): number;
  wxDomEventSnapshotCount(): number;
  wxDomEventSnapshotMaxBytes(): number;
  wxShowContextMenu(
    json: string,
    invokerDomId: number,
    x: number,
    y: number,
    leaseScope: number,
  ): Promise<number>;
  wxCompleteContextMenuLease(scope: number, result: number): boolean;
};

function createHarness() {
  const source = readFileSync(
    new URL("../../../../wxwidgets/build/wasm/wx-dom.js", import.meta.url),
    "utf8",
  );
  const document = new FakeDocument();
  const container = new FakeElement("div");
  container.id = "window-1";
  document.body.appendChild(container);
  const frames: Array<() => void> = [];
  const renderedElements = new Map<string, Record<string, unknown>>();
  const registry = {
    renderedElements,
    registerRendered: (id: string, info: Record<string, unknown>) => {
      renderedElements.set(id, info);
    },
    unregisterRendered: (id: string) => renderedElements.delete(id),
    unregisterRenderedByParent: (parentId: string) => {
      for (const [id, info] of [...renderedElements]) {
        if (String(info.parentId) === String(parentId)) renderedElements.delete(id);
      }
    },
  };
  let deferIngress = false;
  const failScheduler = vi.fn();
  const scheduler = {
    dead: false,
    canTouchNative: () => true,
    runNativeIngressReceipt: (_site: string, run: (token: number) => number) =>
      deferIngress ? 1 : run(1),
    _failScheduler: failScheduler,
    shutdown: vi.fn(),
  };
  const sandbox = vm.createContext({
    document,
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    innerWidth: 1024,
    innerHeight: 768,
    scrollX: 0,
    scrollY: 0,
    wxElementRegistry: registry,
    __wxGetWindowElement: (id: string) => id === "window-1" ? container : null,
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    getComputedStyle: () => ({ font: "12px sans-serif", overflowY: "visible" }),
    Map,
    Set,
    Promise,
    Number,
    Object,
    Array,
    JSON,
    Error,
  });
  (sandbox as Record<string, unknown>).window = sandbox;
  (sandbox as Record<string, unknown>).globalThis = sandbox;

  const makeModule = () => {
    const module = { canvas: new FakeElement("canvas") } as unknown as FakeModule;
    module.__wxScheduler = { ...scheduler, ownerModule: module };
    return module;
  };
  const load = (module: FakeModule, publishScheduler = true) => {
    (sandbox as Record<string, unknown>).Module = module;
    if (publishScheduler)
      (sandbox as Record<string, unknown>).__wxScheduler = module.__wxScheduler;
    vm.runInContext(source, sandbox, { filename: "wx-dom.js" });
  };
  const publishScheduler = (module: FakeModule, scheduler: unknown) => {
    module.__wxScheduler = scheduler;
    (sandbox as Record<string, unknown>).__wxScheduler = scheduler;
  };
  const flushFrames = () => {
    while (frames.length) frames.shift()!();
  };
  const windowObject = sandbox as Record<string, unknown> & {
    wxDomCreateControl(tlw: string, type: string, typeAttr?: string): number;
    wxDomDestroyControl(domId: number): void;
    wxDomSetValue(domId: number, value: string): void;
    wxDomEventSnapshotPush(token: number, domId: number, kind: number): number;
    wxDomEventSnapshotPop(token: number): number;
    wxDomEventSnapshotDiscard(token: number): number;
    wxDomMenuSetStructure(domId: number, json: string): void;
    __wxDomBrowserLifetime: { id: number; active: boolean } | null;
  };

  return {
    container,
    document,
    failScheduler,
    flushFrames,
    frames,
    load,
    makeModule,
    publishScheduler,
    registry,
    renderedElements,
    setIngressDeferred(deferred: boolean) {
      deferIngress = deferred;
    },
    windowObject,
  };
}

function menuStructure(title = "File") {
  return JSON.stringify([{ title, items: [{
    id: 101,
    label: "More",
    kind: "submenu",
    enabled: true,
    items: [{ id: 102, label: "Child", kind: "normal", enabled: true }],
  }] }]);
}

describe("wx DOM browser lifetime", () => {
  it("accounts the exact snapshot payload through push and pop at the byte boundary", () => {
    const h = createHarness();
    const module = h.makeModule();
    h.load(module);
    h.setIngressDeferred(true);

    const domId = h.windowObject.wxDomCreateControl("window-1", "textarea");
    const textarea = h.container.children.find((child) =>
      Number(child.dataset.wxDomId) === domId)!;
    const byteLimit = module.wxDomEventSnapshotMaxBytes();
    h.windowObject.wxDomSetValue(domId, "x".repeat(byteLimit / 2));
    textarea.fire("input");

    expect(module.wxDomEventSnapshotPendingBytes()).toBe(byteLimit);
    expect(module.wxDomEventSnapshotCount()).toBe(1);
    expect(h.windowObject.wxDomEventSnapshotPush(1, domId, 2)).toBe(1);
    expect(h.windowObject.wxDomEventSnapshotPop(1)).toBe(1);
    expect(module.wxDomEventSnapshotPendingBytes()).toBe(0);
    expect(module.wxDomEventSnapshotCount()).toBe(0);
    expect(h.failScheduler).not.toHaveBeenCalled();
  });

  it("refuses an oversized snapshot without retaining it", () => {
    const h = createHarness();
    const module = h.makeModule();
    h.load(module);
    h.setIngressDeferred(true);

    const domId = h.windowObject.wxDomCreateControl("window-1", "textarea");
    const textarea = h.container.children.find((child) =>
      Number(child.dataset.wxDomId) === domId)!;
    const byteLimit = module.wxDomEventSnapshotMaxBytes();
    h.windowObject.wxDomSetValue(domId, "x".repeat(byteLimit / 2 + 1));
    textarea.fire("input");

    expect(module.wxDomEventSnapshotPendingBytes()).toBe(0);
    expect(module.wxDomEventSnapshotCount()).toBe(0);
    expect(h.failScheduler).toHaveBeenCalledWith(
      "DOM event snapshot byte capacity exhausted", false,
    );
  });

  it("releases snapshot bytes exactly once on discard and shutdown", () => {
    const h = createHarness();
    const module = h.makeModule();
    h.load(module);
    h.setIngressDeferred(true);

    const domId = h.windowObject.wxDomCreateControl("window-1", "textarea");
    const textarea = h.container.children.find((child) =>
      Number(child.dataset.wxDomId) === domId)!;
    h.windowObject.wxDomSetValue(domId, "abc");
    textarea.fire("input");
    expect(module.wxDomEventSnapshotPendingBytes()).toBe(6);
    expect(h.windowObject.wxDomEventSnapshotDiscard(1)).toBe(1);
    expect(h.windowObject.wxDomEventSnapshotDiscard(1)).toBe(0);
    expect(module.wxDomEventSnapshotPendingBytes()).toBe(0);

    h.windowObject.wxDomSetValue(domId, "1234");
    textarea.fire("input");
    h.windowObject.wxDomSetValue(domId, "xy");
    textarea.fire("input");
    expect(module.wxDomEventSnapshotPendingBytes()).toBe(12);
    expect(module.wxDomEventSnapshotCount()).toBe(2);

    module.wxDiscardDomEventSnapshots();
    expect(module.wxDomEventSnapshotPendingBytes()).toBe(0);
    expect(module.wxDomEventSnapshotCount()).toBe(0);
    module.wxDiscardDomEventSnapshots();
    expect(module.wxDomEventSnapshotPendingBytes()).toBe(0);
    expect(h.failScheduler).not.toHaveBeenCalled();
  });

  it("never borrows the previous Module scheduler before its owner publishes one", () => {
    const h = createHarness();
    h.load(h.makeModule());

    const replacement = h.makeModule();
    const replacementScheduler = replacement.__wxScheduler;
    delete replacement.__wxScheduler;
    const stage = vi.fn(() => 1);
    replacement._wx_dom_event_stage = stage;

    // Keep the old global scheduler visible while wx-dom installs for the new
    // owner, matching the pre-js-before-scheduler publication window.
    h.load(replacement, false);
    const buttonId = h.windowObject.wxDomCreateControl("window-1", "button");
    const button = h.container.children.find((child) =>
      Number(child.dataset.wxDomId) === buttonId)!;
    button.fire("click");
    expect(stage).not.toHaveBeenCalled();

    h.publishScheduler(replacement, replacementScheduler);
    button.fire("click");
    expect(stage).toHaveBeenCalledOnce();
  });

  it("retires a same-realm module without reusing ids, listeners, or old rAF work", () => {
    const h = createHarness();
    const oldModule = h.makeModule();
    h.load(oldModule);

    const oldDomId = h.windowObject.wxDomCreateControl("window-1", "menubar");
    h.windowObject.wxDomMenuSetStructure(oldDomId, menuStructure());
    const oldTitle = h.container.children[0]!.children[0]!;
    const oldBrowserId = oldTitle.id;
    const oldLifetimeId = h.windowObject.__wxDomBrowserLifetime!.id;
    const listenerCount = h.document.listenerCount();

    // Leave the old title registration queued. Replacement must gate it even
    // if the browser invokes that already-scheduled callback later.
    expect(h.frames.length).toBeGreaterThan(0);
    const replacementModule = h.makeModule();
    h.load(replacementModule);
    expect(oldModule.wxDiscardDomBrowserLifetime()).toBe(false);
    expect(h.document.listenerCount()).toBe(listenerCount);
    expect(oldTitle.isConnected).toBe(false);
    h.flushFrames();
    expect([...h.renderedElements.values()].some((item) => item.browserId === oldBrowserId))
      .toBe(false);

    const newDomId = h.windowObject.wxDomCreateControl("window-1", "menubar");
    h.windowObject.wxDomMenuSetStructure(newDomId, menuStructure("Edit"));
    h.flushFrames();
    const newTitle = h.container.children[0]!.children[0]!;
    expect(newDomId).toBeGreaterThan(oldDomId);
    expect(newTitle.id).not.toBe(oldBrowserId);
    expect(h.windowObject.__wxDomBrowserLifetime!.id).toBeGreaterThan(oldLifetimeId);
  });

  it("destroys owned popups and preserves submenu anchor geometry", () => {
    const h = createHarness();
    h.load(h.makeModule());
    const domId = h.windowObject.wxDomCreateControl("window-1", "menubar");
    h.windowObject.wxDomMenuSetStructure(domId, menuStructure());
    h.flushFrames();

    const title = h.container.children[0]!.children[0]!;
    title.fire("click");
    h.flushFrames();
    const firstPopup = h.document.body.children.find((child) =>
      child.className === "wx-menu-popup")!;
    const submenuAnchor = firstPopup.children[0]!;
    submenuAnchor.fire("click");
    h.flushFrames();
    const submenu = h.document.body.children.find((child) =>
      child.className === "wx-menu-popup")!;
    expect(submenu).not.toBe(firstPopup);
    expect(submenu.style.cssText).toContain("left:40px;");
    expect(submenu.style.cssText).toContain("top:70px;");

    h.windowObject.wxDomDestroyControl(domId);
    expect(h.document.body.children.some((child) => child.className === "wx-menu-popup"))
      .toBe(false);
    expect([...h.renderedElements.values()].some((item) =>
      String(item.parentId).startsWith(String(domId)))).toBe(false);
  });

  it("settles the exact context lease when its invoker is destroyed", async () => {
    const h = createHarness();
    const module = h.makeModule();
    const closes: Array<[number, number]> = [];
    module._wx_popup_lease_request_close = (scope: number, result: number) => {
      closes.push([scope, result]);
      return 1;
    };
    h.load(module);
    const invoker = h.windowObject.wxDomCreateControl("window-1", "button");
    const result = module.wxShowContextMenu(JSON.stringify([{
      id: 7, label: "Cut", kind: "normal", enabled: true,
    }]), invoker, 1, 2, 77);

    h.windowObject.wxDomDestroyControl(invoker);
    await Promise.resolve();
    expect(closes).toEqual([[77, -1]]);
    expect(h.document.body.children.some((child) => child.className === "wx-menu-popup"))
      .toBe(false);
    expect(module.wxCompleteContextMenuLease(77, -1)).toBe(true);
    await expect(result).resolves.toBe(-1);
  });

  it("keeps exact context completion reachable through adapter replacement", async () => {
    const h = createHarness();
    const module = h.makeModule();
    const closes: Array<[number, number]> = [];
    module._wx_popup_lease_request_close = (scope: number, result: number) => {
      closes.push([scope, result]);
      return 1;
    };
    h.load(module);
    const result = module.wxShowContextMenu(JSON.stringify([{
      id: 9, label: "Close", kind: "normal", enabled: true,
    }]), 0, 1, 2, 91);

    h.load(module);
    expect(h.windowObject.__wxDomBrowserLifetime).not.toBeNull();
    expect(closes).toEqual([[91, -1]]);

    // Completion now enters the replacement adapter's exported hook. The
    // realm-owned resolver remains the terminal callback for the old lifetime's
    // already-requested exact native lease.
    expect(module.wxCompleteContextMenuLease(91, -1)).toBe(true);
    await expect(result).resolves.toBe(-1);
  });
});
