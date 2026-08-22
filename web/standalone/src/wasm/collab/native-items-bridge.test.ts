import { describe, expect, it, vi } from "vitest";
import {
  moduleItemsBridge,
  type KicadItemsModule,
  type KicadItemsWindow,
} from "./kicad-binding";

const EMPTY_WIRE = JSON.stringify({ added: [], changed: [], removed: [] });

type Ack = {
  requestId: string;
  ownerGeneration: string;
  status: string;
  retryable?: boolean;
  error?: string;
};

type ProtocolModule = KicadItemsModule & {
  kicadCollabSetItemsOwner(owner: string): boolean | void;
  kicadCollabReleaseItemsOwner(owner: string): void;
};

type ProtocolWindow = KicadItemsWindow & {
  kicadCollab?: KicadItemsWindow["kicadCollab"] & {
    onItemsApplied?: (json: string) => void;
  };
};

function setup(
  opts: {
    ownerAcquired?: boolean;
    ackTimeoutMs?: number;
    submission?: () => unknown;
  } = {},
) {
  const submitted: string[] = [];
  const mod: ProtocolModule = {
    kicadCollabSnapshotItems: () => EMPTY_WIRE,
    kicadCollabApplyItems: (json) => {
      submitted.push(json);
      return opts.submission?.();
    },
    kicadCollabSetItemsOwner: vi.fn(() => opts.ownerAcquired ?? true),
    kicadCollabReleaseItemsOwner: vi.fn(),
  };
  const win: ProtocolWindow = {};
  const bridge = moduleItemsBridge(mod, win, {
    ackTimeoutMs: opts.ackTimeoutMs,
  }) as ReturnType<typeof moduleItemsBridge> & {
    readonly ownerGeneration: string;
    destroy(): void;
  };
  const ack = (value: Ack): void =>
    win.kicadCollab?.onItemsApplied?.(JSON.stringify(value));
  return { ack, bridge, mod, submitted, win };
}

describe("moduleItemsBridge — acknowledged owner-scoped protocol", () => {
  it("keeps an apply pending until the matching native completion", async () => {
    const { ack, bridge, mod, submitted } = setup();

    expect(mod.kicadCollabSetItemsOwner).toHaveBeenCalledWith(bridge.ownerGeneration);
    const completion = bridge.applyItems(EMPTY_WIRE);
    expect(completion).toBeInstanceOf(Promise);
    expect(submitted).toHaveLength(1);

    const wire = JSON.parse(submitted[0]!) as {
      _pcbjam: { requestId: string; ownerGeneration: string };
    };
    expect(wire._pcbjam.ownerGeneration).toBe(bridge.ownerGeneration);

    let settled = false;
    void Promise.resolve(completion).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled, "submission is not an acknowledgement").toBe(false);

    ack({
      requestId: wire._pcbjam.requestId,
      ownerGeneration: wire._pcbjam.ownerGeneration,
      status: "applied",
    });
    await expect(completion).resolves.toBeUndefined();
  });

  it("ignores an acknowledgement for a foreign owner or request", async () => {
    const { ack, bridge, submitted } = setup();
    const completion = bridge.applyItems(EMPTY_WIRE);
    const wire = JSON.parse(submitted[0]!) as {
      _pcbjam: { requestId: string; ownerGeneration: string };
    };
    let settled = false;
    void Promise.resolve(completion).finally(() => {
      settled = true;
    });

    ack({
      requestId: wire._pcbjam.requestId,
      ownerGeneration: "another-binding",
      status: "applied",
    });
    ack({
      requestId: "another-request",
      ownerGeneration: wire._pcbjam.ownerGeneration,
      status: "applied",
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    ack({
      requestId: wire._pcbjam.requestId,
      ownerGeneration: wire._pcbjam.ownerGeneration,
      status: "applied",
    });
    await expect(completion).resolves.toBeUndefined();
  });

  it("turns a native rejection into a typed retryable apply failure", async () => {
    const { ack, bridge, submitted } = setup();
    const completion = bridge.applyItems(EMPTY_WIRE);
    const wire = JSON.parse(submitted[0]!) as {
      _pcbjam: { requestId: string; ownerGeneration: string };
    };

    ack({
      requestId: wire._pcbjam.requestId,
      ownerGeneration: wire._pcbjam.ownerGeneration,
      status: "busy",
      retryable: true,
      error: "file open is in flight",
    });

    await expect(completion).rejects.toMatchObject({
      name: "NativeItemsApplyError",
      status: "busy",
      retryable: true,
    });
  });

  it("release is owner-scoped and rejects every still-pending request", async () => {
    const { bridge, mod } = setup();
    const completion = bridge.applyItems(EMPTY_WIRE);

    bridge.destroy();

    expect(mod.kicadCollabReleaseItemsOwner).toHaveBeenCalledWith(
      bridge.ownerGeneration,
    );
    await expect(completion).rejects.toMatchObject({
      name: "NativeItemsApplyError",
      status: "owner-released",
      retryable: false,
    });
  });

  it("refuses ownership while the previous native generation is still draining", () => {
    expect(() => setup({ ownerAcquired: false })).toThrow(
      "native items owner is still draining its previous generation",
    );
  });

  it("terminally rejects a missing acknowledgement and leaves destroy safe", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, mod } = setup({ ackTimeoutMs: 25 });
      const completion = bridge.applyItems(EMPTY_WIRE);
      const outcome = expect(completion).rejects.toMatchObject({
        name: "NativeItemsApplyError",
        status: "ack-timeout",
        retryable: false,
      });

      await vi.advanceTimersByTimeAsync(25);
      await outcome;

      // The timeout has already removed/settled the ticket; teardown only
      // releases the owner and cannot reject the same request a second time.
      expect(() => bridge.destroy()).not.toThrow();
      expect(mod.kicadCollabReleaseItemsOwner).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the ACK deadline only after an open-deferred submission reaches native", async () => {
    vi.useFakeTimers();
    try {
      let releaseSubmission!: () => void;
      const { bridge } = setup({
        ackTimeoutMs: 25,
        submission: () =>
          new Promise<void>((resolve) => {
            releaseSubmission = resolve;
          }),
      });
      const completion = bridge.applyItems(EMPTY_WIRE);
      let outcome: unknown = "pending";
      void completion.then(
        () => {
          outcome = "resolved";
        },
        (error: unknown) => {
          outcome = error;
        },
      );

      await vi.advanceTimersByTimeAsync(250);
      expect(outcome, "time queued behind open is not native ACK time").toBe("pending");

      releaseSubmission();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      expect(outcome).toMatchObject({
        status: "ack-timeout",
        retryable: false,
      });
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
