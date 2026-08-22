import { describe, expect, it } from "vitest";
import { decideProjectionAck } from "./generated/projection-kernel.js";

const bools = [false, true] as const;

describe("verified projection acknowledgement kernel", () => {
  it("is total and matches every one of the 32 boolean input combinations", () => {
    for (const ownerMatches of bools) {
      for (const requestMatches of bools) {
        for (const dirty of bools) {
          for (const ok of bools) {
            for (const retryable of bools) {
              const expected =
                !ownerMatches || !requestMatches
                  ? 0
                  : ok && dirty
                    ? 2
                    : ok
                      ? 1
                      : retryable
                        ? 3
                        : 4;

              expect(
                decideProjectionAck(
                  ownerMatches,
                  requestMatches,
                  dirty,
                  ok,
                  retryable,
                ),
              ).toBe(expected);
            }
          }
        }
      }
    }
  });

  it("lets stale owner/request identity dominate every completion result", () => {
    expect(decideProjectionAck(false, true, true, true, true)).toBe(0);
    expect(decideProjectionAck(true, false, true, false, true)).toBe(0);
  });

  it("coalesces success to latest, retries only transient failure, and terminalizes the rest", () => {
    expect(decideProjectionAck(true, true, true, true, false)).toBe(2);
    expect(decideProjectionAck(true, true, false, true, false)).toBe(1);
    expect(decideProjectionAck(true, true, true, false, true)).toBe(3);
    expect(decideProjectionAck(true, true, true, false, false)).toBe(4);
  });
});
