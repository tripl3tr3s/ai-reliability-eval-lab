import { describe, expect, it } from "vitest";
import { passAtK, passPowerK, tallyByCase } from "../../src/stats/index.js";

describe("per-case reliability", () => {
  const rows = [
    ...Array.from({ length: 5 }, () => ({ caseId: "a", passed: true })),
    ...Array.from({ length: 5 }, (_, index) => ({ caseId: "b", passed: index < 3 })),
    ...Array.from({ length: 5 }, () => ({ caseId: "c", passed: false })),
  ];

  it("tallies rows per case in case order", () => {
    expect(tallyByCase([...rows].reverse())).toEqual([
      { caseId: "a", passes: 5, trials: 5 },
      { caseId: "b", passes: 3, trials: 5 },
      { caseId: "c", passes: 0, trials: 5 },
    ]);
    expect(tallyByCase([])).toEqual([]);
  });

  it("computes pass@k and pass^k per case and then averages", () => {
    const tallies = tallyByCase(rows);
    // Hand computed: pass@5 = (1 + (1 - 0.4^5) + 0) / 3, pass^5 = (1 + 0.6^5 + 0) / 3.
    expect(passAtK(tallies, 5)).toBeCloseTo((1 + (1 - 0.4 ** 5) + 0) / 3, 12);
    expect(passAtK(tallies, 5)).toBeCloseTo(0.6632533333333334, 12);
    expect(passPowerK(tallies, 5)).toBeCloseTo(0.35925333, 8);
  });

  it("differs from the pooled-row shortcut", () => {
    const tallies = tallyByCase(rows);
    const pooledRate = 8 / 15;
    expect(passAtK(tallies, 5)).not.toBeCloseTo(1 - (1 - pooledRate) ** 5, 2);
    expect(passPowerK(tallies, 5)).not.toBeCloseTo(pooledRate ** 5, 2);
  });

  it("equals the mean pass rate at k = 1", () => {
    const tallies = tallyByCase(rows);
    expect(passAtK(tallies, 1)).toBeCloseTo(8 / 15, 12);
    expect(passPowerK(tallies, 1)).toBeCloseTo(8 / 15, 12);
  });

  it("handles all-pass, all-fail and single-trial cases", () => {
    expect(passAtK([{ caseId: "a", passes: 5, trials: 5 }], 5)).toBe(1);
    expect(passPowerK([{ caseId: "a", passes: 5, trials: 5 }], 5)).toBe(1);
    expect(passAtK([{ caseId: "a", passes: 0, trials: 5 }], 5)).toBe(0);
    expect(passPowerK([{ caseId: "a", passes: 0, trials: 5 }], 5)).toBe(0);
    expect(passAtK([{ caseId: "a", passes: 1, trials: 1 }], 3)).toBe(1);
  });

  it("returns null without usable cases and rejects invalid k", () => {
    expect(passAtK([], 5)).toBeNull();
    expect(passPowerK([{ caseId: "a", passes: 0, trials: 0 }], 5)).toBeNull();
    expect(() => passAtK([], 0)).toThrow(RangeError);
    expect(() => passPowerK([], 1.5)).toThrow(RangeError);
  });
});
