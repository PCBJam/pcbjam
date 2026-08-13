import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../../../../wasm/shims/in_memory_config_pre.js", import.meta.url),
  "utf8",
);

function install(localStorage: unknown): Record<string, unknown> {
  const context: Record<string, unknown> = { localStorage };
  runInNewContext(source, context);
  return context;
}

describe("headless wxConfig pre-js", () => {
  it("replaces Node 25's truthy localStorage placeholder", () => {
    const context = install(Object.create(null));
    const storage = context.localStorage as Storage;
    const setConfigEntry = context.setConfigEntry as (
      key: string,
      value: string,
    ) => void;
    const getConfigEntryLength = context.getConfigEntryLength as (
      key: string,
    ) => number;

    expect(typeof storage.getItem).toBe("function");
    setConfigEntry("/headless/test", "value");
    expect(storage.getItem("/headless/test")).toBe("value");
    expect(getConfigEntryLength("/headless/test")).toBe(5);
  });

  it("keeps a complete host Storage implementation", () => {
    const storage = {
      length: 0,
      key: vi.fn(() => null),
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };

    const context = install(storage);

    expect(context.localStorage).toBe(storage);
    (context.hasConfigEntry as (key: string) => boolean)("/missing");
    expect(storage.getItem).toHaveBeenCalledWith("/missing");
  });
});
