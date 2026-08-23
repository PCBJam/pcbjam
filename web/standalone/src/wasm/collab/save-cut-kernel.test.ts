import { describe, expect, it } from "vitest";
import { decideSaveCut } from "./generated/projection-kernel.js";

const bools = [false, true] as const;

/**
 * App-independent refinement harness for the native projection FIFO.
 *
 * Tickets are accepted in increasing order. The only successful completion is
 * the current head, so acknowledged is a contiguous prefix. A save freezes the
 * current accepted ticket as its cut and may acknowledge persistence only when
 * the verified classifier permits it.
 */
class SaveCutHarness {
  accepted = 0;
  acknowledged = 0;
  inFlight: number | null = null;
  failedAt: number | null = null;
  readonly persistedCuts: number[] = [];

  accept(): number {
    if (this.failedAt !== null) throw new Error("projection FIFO has failed");
    this.accepted += 1;
    return this.accepted;
  }

  beginSave(): number {
    return this.accepted;
  }

  startNext(): number {
    if (this.inFlight !== null) throw new Error("projection already in flight");
    if (this.failedAt !== null) throw new Error("projection FIFO has failed");
    if (this.acknowledged === this.accepted) {
      throw new Error("no queued projection");
    }
    this.inFlight = this.acknowledged + 1;
    return this.inFlight;
  }

  acknowledge(ticket: number): void {
    if (ticket !== this.inFlight || ticket !== this.acknowledged + 1) {
      throw new Error("non-FIFO projection acknowledgement");
    }
    this.acknowledged = ticket;
    this.inFlight = null;
  }

  fail(ticket: number): void {
    if (ticket !== this.inFlight || ticket !== this.acknowledged + 1) {
      throw new Error("non-FIFO projection failure");
    }
    this.failedAt = ticket;
    this.inFlight = null;
  }

  decision(cut: number, timedOut = false): 0 | 1 | 4 {
    const acknowledgedThroughCut = this.acknowledged >= cut;
    const projectionFailedThroughCut =
      this.failedAt !== null && this.failedAt <= cut;
    return decideSaveCut(
      acknowledgedThroughCut,
      timedOut,
      projectionFailedThroughCut,
    );
  }

  acknowledgePersistence(cut: number, timedOut = false): boolean {
    if (this.decision(cut, timedOut) !== 1) return false;
    this.persistedCuts.push(cut);
    return true;
  }
}

describe("verified save-cut kernel", () => {
  it("is total and fail-closed for all eight classifier inputs", () => {
    for (const acknowledgedThroughCut of bools) {
      for (const timedOut of bools) {
        for (const projectionFailedThroughCut of bools) {
          const expected = projectionFailedThroughCut
            ? 4
            : acknowledgedThroughCut
              ? 1
              : timedOut
                ? 4
                : 0;
          expect(
            decideSaveCut(
              acknowledgedThroughCut,
              timedOut,
              projectionFailedThroughCut,
            ),
          ).toBe(expected);
        }
      }
    }
  });

  it("persists immediately at an idle cut", () => {
    const fifo = new SaveCutHarness();
    const cut = fifo.beginSave();

    expect(cut).toBe(0);
    expect(fifo.decision(cut)).toBe(1);
    expect(fifo.acknowledgePersistence(cut)).toBe(true);
    expect(fifo.persistedCuts).toEqual([0]);
  });

  it("waits for both queued and in-flight projections through the cut", () => {
    const fifo = new SaveCutHarness();
    const ticket = fifo.accept();
    const cut = fifo.beginSave();

    expect(fifo.decision(cut)).toBe(0);
    expect(fifo.acknowledgePersistence(cut)).toBe(false);
    expect(fifo.startNext()).toBe(ticket);
    expect(fifo.decision(cut)).toBe(0);

    fifo.acknowledge(ticket);
    expect(fifo.decision(cut)).toBe(1);
    expect(fifo.acknowledgePersistence(cut)).toBe(true);
    expect(fifo.persistedCuts).toEqual([cut]);
  });

  it("times out fail-closed without acknowledging stale persistence", () => {
    const fifo = new SaveCutHarness();
    fifo.accept();
    const cut = fifo.beginSave();

    expect(fifo.decision(cut, true)).toBe(4);
    expect(fifo.acknowledgePersistence(cut, true)).toBe(false);
    expect(fifo.persistedCuts).toEqual([]);
  });

  it("keeps a frozen cut stable when a newer projection is accepted", () => {
    const fifo = new SaveCutHarness();
    const throughCut = fifo.accept();
    const cut = fifo.beginSave();
    const afterCut = fifo.accept();

    expect(cut).toBe(throughCut);
    expect(afterCut).toBeGreaterThan(cut);
    fifo.startNext();
    fifo.acknowledge(throughCut);
    expect(fifo.startNext()).toBe(afterCut);

    expect(fifo.decision(cut)).toBe(1);
    expect(fifo.acknowledgePersistence(cut)).toBe(true);
    expect(fifo.acknowledged).toBe(cut);
    expect(fifo.inFlight).toBe(afterCut);
  });

  it("does not let a failure strictly after the cut invalidate a drained save", () => {
    const fifo = new SaveCutHarness();
    const throughCut = fifo.accept();
    const cut = fifo.beginSave();
    const afterCut = fifo.accept();

    fifo.startNext();
    fifo.acknowledge(throughCut);
    fifo.startNext();
    fifo.fail(afterCut);

    expect(fifo.acknowledged).toBe(cut);
    expect(fifo.failedAt).toBeGreaterThan(cut);
    expect(fifo.decision(cut)).toBe(1);
    expect(fifo.acknowledgePersistence(cut)).toBe(true);
  });

  it("fails immediately when a projection through the cut fails", () => {
    const fifo = new SaveCutHarness();
    const ticket = fifo.accept();
    const cut = fifo.beginSave();
    fifo.startNext();
    fifo.fail(ticket);

    expect(fifo.decision(cut)).toBe(4);
    expect(fifo.acknowledgePersistence(cut)).toBe(false);
    expect(fifo.persistedCuts).toEqual([]);
  });

  it("rejects out-of-order acknowledgement instead of manufacturing a drain", () => {
    const fifo = new SaveCutHarness();
    fifo.accept();
    fifo.accept();
    fifo.startNext();

    expect(() => fifo.acknowledge(2)).toThrow(
      "non-FIFO projection acknowledgement",
    );
    expect(fifo.acknowledged).toBe(0);
  });
});
