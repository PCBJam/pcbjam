import { afterEach, describe, expect, it } from "vitest";
import { startLibIndexWarmup } from "./lib-index-warmup";

describe("startLibIndexWarmup", () => {
  const setSearch = (search: string) => {
    (globalThis as unknown as { window: unknown }).window = { location: { search } };
  };
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("calls the export once nothing is opening, and logs it", async () => {
    setSearch("");
    const calls: string[] = [];
    const logs: string[] = [];
    await startLibIndexWarmup(
      { kicadOpenFileBusy: () => false, kicadLibIndexWarmup: (k: string) => calls.push(k) },
      (m) => logs.push(m),
    );
    expect(calls).toEqual(["symbol"]);
    expect(logs).toEqual(["[libindex] warm-up started"]);
  });

  it("does nothing under ?libwarm=0 or ?libindex=0, or without the export", async () => {
    const calls: string[] = [];
    const mod = { kicadLibIndexWarmup: (k: string) => calls.push(k) };
    setSearch("?libwarm=0");
    await startLibIndexWarmup(mod, () => {});
    setSearch("?libindex=0");
    await startLibIndexWarmup(mod, () => {});
    setSearch("");
    await startLibIndexWarmup({}, () => {});
    expect(calls).toEqual([]);
  });
});
