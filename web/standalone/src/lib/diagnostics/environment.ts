import { probeCapabilities } from "@/preflight/capabilities";
import { currentTheme } from "@/lib/theme";
import { heapBytes } from "@/wasm/load-trace";

/**
 * Browser, OS and machine facts for a problem report (problem-reports 0001).
 * Builds on the preflight probe (SAB, isolation, threads, WebGL2 + GPU, memory,
 * cores, screen) and adds what only matters when triaging. Every probe is
 * best-effort: an exotic browser yields fewer keys, never an exception.
 */

/** The subset of `navigator.userAgentData` we read (Chromium only). */
export interface UaData {
  brands?: { brand: string; version: string }[];
  platform?: string;
  platformVersion?: string;
  fullVersionList?: { brand: string; version: string }[];
}

/** Brands worth naming, most specific first (Chromium lists all of them). */
const BRANDS: [string, string][] = [
  ["Microsoft Edge", "Edge"],
  ["Opera", "Opera"],
  ["Brave", "Brave"],
  ["Google Chrome", "Chrome"],
  ["Chromium", "Chromium"],
];

/** User-agent fallbacks, checked in order (Edge and Opera also say Chrome). */
const UA_BROWSERS: [RegExp, string][] = [
  [/Firefox\/(\d+)/, "Firefox"],
  [/Edg\/(\d+)/, "Edge"],
  [/OPR\/(\d+)/, "Opera"],
  [/Chrome\/(\d+)/, "Chrome"],
  [/Version\/(\d+)[\d.]* .*Safari\//, "Safari"],
];

const major = (v: string | undefined) => v?.split(".")[0];

/** A short browser label, e.g. "Chrome 141" or "Firefox 144". */
export function browserLabel(ua: string, data?: UaData | null): string | undefined {
  const list = data?.fullVersionList ?? data?.brands;
  if (list?.length) {
    for (const [brand, label] of BRANDS) {
      const hit = list.find((b) => b.brand === brand);
      if (hit) return `${label} ${major(hit.version)}`;
    }
  }
  for (const [re, label] of UA_BROWSERS) {
    const m = re.exec(ua);
    if (m) return `${label} ${m[1]}`;
  }
  return undefined;
}

/**
 * A short OS label, e.g. "macOS 15.6" or "Windows 11". User agents freeze the
 * OS version (macOS always reads 10.15.7), so the precise one comes from
 * `userAgentData.platformVersion` when the browser has it.
 */
export function osLabel(ua: string, data?: UaData | null): string | undefined {
  const platform = data?.platform;
  const version = data?.platformVersion;
  if (platform === "macOS") return version ? `macOS ${version.split(".").slice(0, 2).join(".")}` : "macOS";
  if (platform === "Windows") {
    // Chromium reports Windows 11 as platformVersion 13+.
    const n = Number(major(version));
    return Number.isFinite(n) && version ? (n >= 13 ? "Windows 11" : "Windows 10") : "Windows";
  }
  if (platform === "Chrome OS" || platform === "ChromeOS") return "ChromeOS";
  if (platform === "Android") return version ? `Android ${major(version)}` : "Android";
  if (platform === "Linux") return "Linux";
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/.exec(ua);
  if (ios) return `iOS ${ios[1]}.${ios[2]}`;
  const android = /Android (\d+)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}

async function safe<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** Collect the environment; never throws. */
export async function collectEnvironment(): Promise<Record<string, unknown> & { browser?: string; os?: string; userAgent?: string }> {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const ua = nav?.userAgent ?? "";
  const env: Record<string, unknown> = {};

  const caps = await safe(() => probeCapabilities());
  if (caps) Object.assign(env, caps.info);

  const uaApi = (nav as unknown as { userAgentData?: UaData & { mobile?: boolean; getHighEntropyValues?: (hints: string[]) => Promise<UaData & Record<string, unknown>> } } | undefined)?.userAgentData;
  const uaData = await safe(() =>
    uaApi?.getHighEntropyValues?.(["platform", "platformVersion", "architecture", "bitness", "model", "fullVersionList"]),
  );
  if (uaData) env.userAgentData = uaData;

  env.browser = browserLabel(ua, uaData ?? uaApi);
  env.os = osLabel(ua, uaData ?? uaApi);
  env.userAgent = ua || undefined;

  await safe(() => {
    env.jspi = typeof WebAssembly === "object" && "Suspending" in WebAssembly;
    env.viewport = `${window.innerWidth}x${window.innerHeight}`;
    env.devicePixelRatio = window.devicePixelRatio;
    env.screen = `${screen.width}x${screen.height}`;
    env.language = nav?.language;
    env.languages = nav?.languages?.slice(0, 5);
    env.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    env.colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    env.appTheme = currentTheme();
    env.online = nav?.onLine;
    env.maxTouchPoints = nav?.maxTouchPoints;
  });

  const storage = await safe(() => nav?.storage?.estimate?.());
  if (storage) env.storage = { usage: storage.usage, quota: storage.quota };

  await safe(() => {
    const conn = (nav as unknown as { connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean } })?.connection;
    if (conn) env.connection = { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt, saveData: conn.saveData };
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (mem) env.jsHeap = { used: mem.usedJSHeapSize, total: mem.totalJSHeapSize, limit: mem.jsHeapSizeLimit };
    const heap = heapBytes();
    if (heap) env.wasmHeapBytes = heap;
  });

  return env as Record<string, unknown> & { browser?: string; os?: string; userAgent?: string };
}
