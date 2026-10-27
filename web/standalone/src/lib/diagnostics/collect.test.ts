import { PROBLEM_REPORT_LIMITS, type ProblemReportLogs } from "@pcbjam/shared";
import { describe, expect, it } from "vitest";
import { failedRequests, fitContext, fitLogs, jsonBytes, redactedUrl } from "./collect";
import { browserLabel, osLabel } from "./environment";

function logs(partial: Partial<ProblemReportLogs> = {}): ProblemReportLogs {
  return { console: [], editor: [], errors: [], network: [], errorEventIds: [], ...partial };
}

const entry = (i: number, text = `line ${i}`) => ({ t: i, level: "log" as const, text });

describe("fitLogs", () => {
  it("caps each section's count, keeping the newest", () => {
    const out = fitLogs(
      logs({
        console: Array.from({ length: PROBLEM_REPORT_LIMITS.consoleEntries + 5 }, (_, i) => entry(i)),
        editor: Array.from({ length: PROBLEM_REPORT_LIMITS.editorLines + 5 }, (_, i) => `e${i}`),
        network: Array.from({ length: PROBLEM_REPORT_LIMITS.network + 5 }, (_, i) => ({ t: i, url: "u", status: 500, durationMs: 1 })),
      }),
    );
    expect(out.console).toHaveLength(PROBLEM_REPORT_LIMITS.consoleEntries);
    expect(out.console[0]?.t).toBe(5);
    expect(out.editor).toHaveLength(PROBLEM_REPORT_LIMITS.editorLines);
    expect(out.editor[0]).toBe("e5");
    expect(out.network).toHaveLength(PROBLEM_REPORT_LIMITS.network);
  });

  it("drops the oldest console entries first to fit the byte budget", () => {
    const text = "z".repeat(1000);
    const input = logs({
      console: Array.from({ length: 50 }, (_, i) => entry(i, text)),
      editor: ["keep me"],
    });
    const max = 20_000;
    const out = fitLogs(input, max);
    expect(jsonBytes(out)).toBeLessThanOrEqual(max);
    expect(out.editor).toEqual(["keep me"]);
    expect(out.console.at(-1)!.t).toBe(49);
    expect(out.console.length).toBeLessThan(50);
  });

  it("then sheds editor lines and the dumps", () => {
    const out = fitLogs(
      logs({
        editor: Array.from({ length: 100 }, () => "q".repeat(500)),
        loadTrace: "t".repeat(5000),
        wxWaitDump: "w".repeat(5000),
      }),
      8000,
    );
    expect(out.console).toEqual([]);
    expect(out.editor.length).toBeLessThan(100);
    expect(out.loadTrace).toBeUndefined();
    expect(out.wxWaitDump).toBeUndefined();
  });

  it("leaves a small report alone", () => {
    const input = logs({ console: [entry(1)], editor: ["a"], loadTrace: "trace" });
    expect(fitLogs(input)).toEqual(input);
  });
});

describe("fitContext", () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `dir/file-${i}.kicad_sch`, size: i }));

  it("caps the file list and says how many were left out", () => {
    const out = fitContext({ app: {}, env: {}, page: { url: "u", files: files(PROBLEM_REPORT_LIMITS.files + 7) } });
    expect(out.page.files).toHaveLength(PROBLEM_REPORT_LIMITS.files);
    expect(out.page.filesOmitted).toBe(7);
  });

  it("halves the file list until the context fits", () => {
    const max = 4000;
    const out = fitContext({ app: {}, env: {}, page: { url: "u", files: files(400) } }, max);
    expect(jsonBytes(out)).toBeLessThanOrEqual(max);
    expect((out.page.files as unknown[]).length).toBeGreaterThan(0);
    expect(Number(out.page.filesOmitted)).toBeGreaterThan(0);
  });

  it("falls back to the bare page keys when nothing else helps", () => {
    const out = fitContext(
      { app: {}, env: { userAgentData: { blob: "u".repeat(5000) } }, page: { url: "u", tool: "pcbnew", file: "a.kicad_pcb", junk: "j".repeat(5000) } },
      2000,
    );
    expect(out.page).toEqual({ url: "u", tool: "pcbnew", file: "a.kicad_pcb" });
    expect(out.env.userAgentData).toBeUndefined();
  });
});

describe("redactedUrl", () => {
  it("scrubs credential query values and keeps the rest", () => {
    const url = redactedUrl("https://edit.pcbjam.com/team/projects/board/main.kicad_pcb?copy=abc&token=s3cret&api_key=k");
    expect(url).toContain("copy=abc");
    expect(url).not.toContain("s3cret");
    expect(url).toContain("token=[redacted]");
    expect(url).toContain("api_key=[redacted]");
  });
});

describe("failedRequests", () => {
  it("keeps >= 400 responses with redacted URLs", () => {
    const entries = [
      { name: "https/api/files/a", responseStatus: 200, startTime: 1, duration: 2, initiatorType: "fetch" },
      { name: "https/api/files/b?token=zzz", responseStatus: 404, startTime: 3, duration: 4.4, initiatorType: "fetch" },
      { name: "https/cdn/x.wasm", startTime: 5, duration: 6 },
      { name: "https/api/c", responseStatus: 503, startTime: 7, duration: 8, initiatorType: "xmlhttprequest" },
    ] as unknown as PerformanceEntry[];
    const out = failedRequests(entries);
    expect(out.map((r) => r.status)).toEqual([404, 503]);
    expect(out[0]?.url).not.toContain("zzz");
    expect(out[0]?.durationMs).toBe(4);
    expect(out[1]?.initiator).toBe("xmlhttprequest");
  });
});

describe("browser and OS labels", () => {
  const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const WIN_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
  const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";
  const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

  it("reads the user agent", () => {
    expect(browserLabel(MAC_CHROME)).toBe("Chrome 141");
    expect(browserLabel(WIN_EDGE)).toBe("Edge 141");
    expect(browserLabel(FIREFOX)).toBe("Firefox 144");
    expect(browserLabel(SAFARI)).toBe("Safari 26");
    expect(osLabel(MAC_CHROME)).toBe("macOS");
    expect(osLabel(WIN_EDGE)).toBe("Windows");
    expect(osLabel(FIREFOX)).toBe("Linux");
    expect(osLabel(IPHONE)).toBe("iOS 18.5");
  });

  it("prefers userAgentData when the browser has it", () => {
    const data = {
      platform: "macOS",
      platformVersion: "15.6.1",
      fullVersionList: [
        { brand: "Not)A;Brand", version: "8.0.0.0" },
        { brand: "Chromium", version: "141.0.7390.55" },
        { brand: "Google Chrome", version: "141.0.7390.55" },
      ],
    };
    expect(browserLabel(MAC_CHROME, data)).toBe("Chrome 141");
    expect(osLabel(MAC_CHROME, data)).toBe("macOS 15.6");
    expect(osLabel(WIN_EDGE, { platform: "Windows", platformVersion: "19.0.0" })).toBe("Windows 11");
    expect(osLabel(WIN_EDGE, { platform: "Windows", platformVersion: "10.0.0" })).toBe("Windows 10");
  });
});
