import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const docDestroy = vi.fn();
  const providerDestroy = vi.fn();
  const setLocalState = vi.fn();
  const awarenessOn = vi.fn();
  const awarenessOff = vi.fn();
  const connectProvider = vi.fn();
  const awareness = {
    clientID: 1,
    setLocalState,
    on: awarenessOn,
    off: awarenessOff,
    getStates: vi.fn(() => new Map()),
  };
  return {
    awareness,
    awarenessOff,
    awarenessOn,
    connectProvider,
    docDestroy,
    providerDestroy,
    setLocalState,
  };
});

vi.mock("yjs", () => ({
  Doc: class {
    destroy(): void {
      fakes.docDestroy();
    }
  },
}));
vi.mock("./provider", () => ({ connectProvider: fakes.connectProvider }));
vi.mock("./presence", () => ({ claimedPresenceColor: () => undefined }));

import { startCrossAppPresence } from "./cross-app";

const options = {
  scopeId: "S",
  projectId: "P",
  provider: { kind: "broadcastchannel" as const },
  user: { id: "alice", name: "Alice", color: "#123456" },
  tool: "pcbnew",
};

beforeEach(() => {
  fakes.docDestroy.mockReset();
  fakes.providerDestroy.mockReset();
  fakes.setLocalState.mockReset();
  fakes.awarenessOn.mockReset();
  fakes.awarenessOff.mockReset();
  fakes.awareness.getStates.mockReset().mockReturnValue(new Map());
  fakes.connectProvider.mockReset().mockResolvedValue({
    awareness: fakes.awareness,
    destroy: fakes.providerDestroy,
  });
});

describe("cross-app exact teardown", () => {
  it("retires every resource when awareness and provider cleanup throw", async () => {
    const handle = await startCrossAppPresence(options);
    expect(handle).toBeDefined();
    fakes.awarenessOff.mockImplementation(() => {
      throw new Error("listener teardown failed");
    });
    fakes.setLocalState.mockImplementation((state: unknown) => {
      if (state === null) throw new Error("awareness teardown failed");
    });
    fakes.providerDestroy.mockImplementation(() => {
      throw new Error("provider teardown failed");
    });

    expect(() => handle!.destroy()).not.toThrow();
    expect(fakes.awarenessOff).toHaveBeenCalledTimes(1);
    expect(fakes.providerDestroy).toHaveBeenCalledTimes(1);
    expect(fakes.docDestroy).toHaveBeenCalledTimes(1);

    const publications = fakes.setLocalState.mock.calls.length;
    handle!.setSelection(["late"]);
    handle!.setDocPath("late.kicad_pcb");
    expect(fakes.setLocalState).toHaveBeenCalledTimes(publications);
    expect(handle!.peers()).toEqual([]);
  });

  it("destroys the document when a provider without awareness throws on destroy", async () => {
    fakes.providerDestroy.mockImplementation(() => {
      throw new Error("provider teardown failed");
    });
    fakes.connectProvider.mockResolvedValue({
      awareness: undefined,
      destroy: fakes.providerDestroy,
    });

    await expect(startCrossAppPresence(options)).resolves.toBeUndefined();
    expect(fakes.providerDestroy).toHaveBeenCalledTimes(1);
    expect(fakes.docDestroy).toHaveBeenCalledTimes(1);
  });

  it("retires the connected provider and document when initial publish fails", async () => {
    fakes.setLocalState.mockImplementation((state: unknown) => {
      if (state !== null) throw new Error("initial publish failed");
    });

    await expect(startCrossAppPresence(options)).rejects.toThrow(
      "initial publish failed",
    );
    expect(fakes.providerDestroy).toHaveBeenCalledTimes(1);
    expect(fakes.docDestroy).toHaveBeenCalledTimes(1);
  });
});
