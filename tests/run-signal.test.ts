import { describe, expect, it, vi } from "vitest";
import { createRunSignalController } from "../src/run-signal.js";

describe("run signal handling", () => {
  it("aborts gracefully on the first interrupt and forces exit 130 on the second", () => {
    const forceExit = vi.fn();
    const runSignal = createRunSignalController(forceExit);

    runSignal.handleInterrupt();
    expect(runSignal.signal.aborted).toBe(true);
    expect(runSignal.signal.reason).toBeInstanceOf(Error);
    expect(forceExit).not.toHaveBeenCalled();

    runSignal.handleInterrupt();
    expect(forceExit).toHaveBeenCalledWith(130);
  });
});
