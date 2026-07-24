import { afterEach, describe, expect, it, vi } from "vitest";
import { currentTheme, initTheme, setTheme } from "./theme";

/** Stub the browser surface theme.ts touches (node test environment). */
function setup(opts: { search?: string; stored?: string; osDark?: boolean }) {
  const store = new Map<string, string>();
  if (opts.stored) store.set("pcbjam-theme", opts.stored);

  const classes = new Set<string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("window", {
    location: { search: opts.search ?? "" },
    matchMedia: () => ({ matches: opts.osDark ?? false }),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        toggle: (name: string, on: boolean) => {
          if (on) classes.add(name);
          else classes.delete(name);
        },
        contains: (name: string) => classes.has(name),
      },
    },
  });
  return { store, classes };
}

afterEach(() => vi.unstubAllGlobals());

describe("theme resolution (comments-ux 0002): param > storage > OS", () => {
  it("uses the OS preference when nothing else is set", () => {
    setup({ osDark: true });
    expect(currentTheme()).toBe("dark");
    setup({ osDark: false });
    expect(currentTheme()).toBe("light");
  });

  it("stored choice beats the OS preference", () => {
    setup({ stored: "light", osDark: true });
    expect(currentTheme()).toBe("light");
  });

  it("?theme= beats storage and persists on init (platform hand-off)", () => {
    const { store, classes } = setup({ search: "?theme=dark", stored: "light" });
    expect(currentTheme()).toBe("dark");
    initTheme();
    expect(store.get("pcbjam-theme")).toBe("dark");
    expect(classes.has("dark")).toBe(true);
  });

  it("ignores an invalid ?theme= value", () => {
    setup({ search: "?theme=blue", stored: "dark" });
    expect(currentTheme()).toBe("dark");
  });

  it("setTheme persists and applies <html>.dark", () => {
    const { store, classes } = setup({});
    setTheme("dark");
    expect(store.get("pcbjam-theme")).toBe("dark");
    expect(classes.has("dark")).toBe(true);
    setTheme("light");
    expect(classes.has("dark")).toBe(false);
  });
});
