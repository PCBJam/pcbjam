import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_AI_CHAT, announcedRelease, featuredRelease, releaseDay, resetWhatsNewForTest, whatsNew, type WhatsNewState } from "./whats-new";

const release = (version: string, unread: boolean) => ({
  version,
  date: "2026-11-19",
  title: `Release ${version}`,
  modal: true,
  unread,
  highlights: [],
});

const answer = (over: Record<string, unknown> = {}) => ({
  releases: [release("0.3.4", true), release("0.3.3", true)],
  unread: "0.3.4",
  muted: false,
  fresh: [OPEN_AI_CHAT],
  ai: "offer",
  ...over,
});

function mockApi(...bodies: unknown[]) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const body of bodies) spy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(body) } as Response);
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetWhatsNewForTest();
});

describe("whatsNew", () => {
  it("is empty until the backend answered", () => {
    expect(whatsNew.get()).toBeNull();
  });

  it("loads the state with the session cookie", async () => {
    const f = mockApi(answer());
    await whatsNew.refresh();
    expect(f.mock.calls[0]![0]).toMatch(/\/api\/whats-new$/);
    expect(f.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "include" });
    expect(whatsNew.get()).toMatchObject({ unread: "0.3.4", muted: false, fresh: [OPEN_AI_CHAT], ai: "offer" });
  });

  it("keeps what it had when the backend fails or answers something else", async () => {
    mockApi(answer());
    await whatsNew.refresh();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    await whatsNew.refresh();
    expect(whatsNew.get()?.unread).toBe("0.3.4");
    mockApi({ message: "nope" });
    await whatsNew.refresh();
    expect(whatsNew.get()?.unread).toBe("0.3.4");
  });

  it("reads an unknown ai value as none", async () => {
    mockApi(answer({ ai: "soon" }));
    await whatsNew.refresh();
    expect(whatsNew.get()?.ai).toBe("none");
  });

  it("marks the notes seen at once and tells the backend the newest unread version", async () => {
    const f = mockApi(answer(), answer({ unread: null, releases: [release("0.3.4", false), release("0.3.3", false)] }));
    await whatsNew.refresh();
    whatsNew.markSeen();
    expect(whatsNew.get()?.unread).toBeNull();
    expect(whatsNew.get()?.releases.every((r) => !r.unread)).toBe(true);
    expect(f.mock.calls[1]![0]).toMatch(/\/api\/whats-new\/seen$/);
    expect(f.mock.calls[1]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ version: "0.3.4" }) });
  });

  it("does not call the backend with nothing unread", async () => {
    const f = mockApi(answer({ unread: null }));
    await whatsNew.refresh();
    whatsNew.markSeen();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("takes a tried action's dot away once", async () => {
    const f = mockApi(answer(), answer({ fresh: [] }));
    await whatsNew.refresh();
    whatsNew.markTried(OPEN_AI_CHAT);
    expect(whatsNew.get()?.fresh).toEqual([]);
    expect(f.mock.calls[1]![0]).toMatch(/\/api\/whats-new\/tried$/);
    expect(f.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ action: OPEN_AI_CHAT }) });
    whatsNew.markTried(OPEN_AI_CHAT);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("which release shows", () => {
  const highlight = { id: "a", title: "A", text: "About A.", plan: null, action: null };
  const rel = (version: string, over: Record<string, unknown> = {}) => ({ ...release(version, true), ...over });
  const state = (releases: ReturnType<typeof rel>[], over: Record<string, unknown> = {}) => answer({ releases, ...over }) as WhatsNewState;

  it("announces an unread big release that has highlights", () => {
    const s = state([rel("0.3.4", { highlights: [highlight] })]);
    expect(announcedRelease(s)?.version).toBe("0.3.4");
  });

  it("announces nothing for a release of notes only, big or not", () => {
    expect(announcedRelease(state([rel("0.3.4", { modal: true })]))).toBeNull();
    expect(announcedRelease(state([rel("0.3.4", { modal: false })]))).toBeNull();
  });

  it("announces nothing that is small, seen or switched off", () => {
    expect(announcedRelease(state([rel("0.3.4", { modal: false, highlights: [highlight] })]))).toBeNull();
    expect(announcedRelease(state([rel("0.3.4", { unread: false, highlights: [highlight] })]))).toBeNull();
    expect(announcedRelease(state([rel("0.3.4", { highlights: [highlight] })], { muted: true }))).toBeNull();
    expect(announcedRelease(null)).toBeNull();
  });

  it("announces the big release under a newer one of notes only, and the panel shows it", () => {
    const s = state([rel("0.3.5", { modal: false }), rel("0.3.4", { highlights: [highlight] })]);
    expect(announcedRelease(s)?.version).toBe("0.3.4");
    expect(featuredRelease(s)?.version).toBe("0.3.4");
  });

  it("shows the newest release when no unread one has highlights", () => {
    const seen = state([rel("0.3.5", { unread: false }), rel("0.3.4", { unread: false, highlights: [highlight] })]);
    expect(featuredRelease(seen)?.version).toBe("0.3.5");
    expect(featuredRelease(state([]))).toBeNull();
    expect(featuredRelease(null)).toBeNull();
  });
});

describe("releaseDay", () => {
  it("writes the day out, the same in every time zone", () => {
    expect(releaseDay("2026-11-19")).toBe("19 Nov 2026");
    expect(releaseDay("2026-01-01")).toBe("1 Jan 2026");
  });

  it("leaves what is not a day as it is", () => {
    expect(releaseDay("soon")).toBe("soon");
  });
});
