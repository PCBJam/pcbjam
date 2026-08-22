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
  kicadCollabSetItemsOwner(owner: string): void;
  kicadCollabReleaseItemsOwner(owner: string): void;
};

type ProtocolWindow = KicadItemsWindow & {
  kicadCollab?: KicadItemsWindow["kicadCollab"] & {
    onItemsApplied?: (json: string) => void;
  };
};

function setup() {
  const submitted: string[] = [];
  const mod: ProtocolModule = {
    kicadCollabSnapshotItems: () => EMPTY_WIRE,
    kicadCollabApplyItems: (json) => {
      submitted.push(json);
    },
    kicadCollabSetItemsOwner: vi.fn(),
    kicadCollabReleaseItemsOwner: vi.fn(),
  };
  const win: ProtocolWindow = {};
  const bridge = moduleItemsBridge(mod, win) as ReturnType<typeof moduleItemsBridge> & {
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
});
