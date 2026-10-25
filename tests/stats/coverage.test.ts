import { describe, expect, it } from "vitest";
import { bonettPriceClusterInterval, bonettPriceInterval, mulberry32, wilsonInterval, type Interval } from "../../src/stats/index.js";

// Seeded Monte Carlo coverage checks at the benchmark's sample sizes (30 and 90 cases). Criteria were fixed
// before the first run: mean coverage over the scenario grid within 2 points of 95%, and no scenario below
// 90%. Bonett-Price is known to be conservative, so its upper limit is 99%; over-coverage is the safe
// direction for a go-live gate and is reported, not hidden, in the decision record. 2 000 simulations per scenario
// give a Monte Carlo standard error of about 0.5 points per scenario.
const SIMULATIONS = 2_000;
const covers = ({ low, high }: Interval, truth: number): boolean => low <= truth && truth <= high;

function summarize(coverages: readonly number[]): { mean: number; min: number } {
  return { mean: coverages.reduce((sum, value) => sum + value, 0) / coverages.length, min: Math.min(...coverages) };
}

describe.each([30, 90])("coverage at n = %i", (cases) => {
  it("Wilson covers a single rate at its nominal level", () => {
    const random = mulberry32(1_000 + cases);
    const grid = Array.from({ length: 19 }, (_, index) => 0.05 * (index + 1));
    const coverages = grid.map((truth) => {
      let hits = 0;
      for (let simulation = 0; simulation < SIMULATIONS; simulation += 1) {
        let successes = 0;
        for (let draw = 0; draw < cases; draw += 1) successes += Number(random() < truth);
        hits += Number(covers(wilsonInterval(successes, cases), truth));
      }
      return hits / SIMULATIONS;
    });
    const { mean, min } = summarize(coverages);
    expect(mean).toBeGreaterThanOrEqual(0.93);
    expect(mean).toBeLessThanOrEqual(0.97);
    expect(min).toBeGreaterThanOrEqual(0.9);
  });

  it("Bonett-Price covers a paired difference of proportions at or above its nominal level", () => {
    const random = mulberry32(2_000 + cases);
    // Moderate pass rates (70% of concordant pairs pass both), high pass rates near the ceiling (95%), and
    // large differences, where the interval approaches its [-1, 1] limits.
    const scenarios = [
      ...[0.05, 0.1, 0.2, 0.4].flatMap((discordance) => [0, discordance / 2].map((difference) => ({ discordance, difference, passShare: 0.7 }))),
      ...[0.02, 0.05, 0.1].flatMap((discordance) => [0, discordance / 2, discordance].map((difference) => ({ discordance, difference, passShare: 0.95 }))),
      { discordance: 0.4, difference: 0.3, passShare: 0.9 },
      { discordance: 0.5, difference: 0.4, passShare: 0.5 },
    ];
    const coverages = scenarios.map(({ discordance, difference, passShare }) => {
      const firstOnly = (discordance + difference) / 2;
      const secondOnly = (discordance - difference) / 2;
      const bothPassed = (1 - discordance) * passShare;
      let hits = 0;
      for (let simulation = 0; simulation < SIMULATIONS; simulation += 1) {
        const cell = { firstOnly: 0, secondOnly: 0, bothPassed: 0, bothFailed: 0 };
        for (let draw = 0; draw < cases; draw += 1) {
          const value = random();
          if (value < firstOnly) cell.firstOnly += 1;
          else if (value < firstOnly + secondOnly) cell.secondOnly += 1;
          else if (value < firstOnly + secondOnly + bothPassed) cell.bothPassed += 1;
          else cell.bothFailed += 1;
        }
        hits += Number(covers(bonettPriceInterval(cell), difference));
      }
      return hits / SIMULATIONS;
    });
    const { mean, min } = summarize(coverages);
    expect(mean).toBeGreaterThanOrEqual(0.93);
    expect(mean).toBeLessThanOrEqual(0.99);
    expect(min).toBeGreaterThanOrEqual(0.9);
  });

  it("the case-clustered Bonett-Price covers a difference of per-case rates over five repeats (multi-run, informational)", () => {
    const random = mulberry32(3_000 + cases);
    const repeats = 5;
    // Each case has its own pass probability in the reference arm, uniform on [low, low + width]. The candidate
    // arm adds a per-case effect: none, a constant shift, or +/-0.15 with mean zero. The last two scenarios sit
    // near the ceiling, where most cases pass every repeat, and at a large difference.
    const scenarios: readonly { readonly truth: number; readonly low: number; readonly width: number; readonly effect: () => number }[] = [
      { truth: 0, low: 0.3, width: 0.5, effect: () => 0 },
      { truth: 0.1, low: 0.3, width: 0.5, effect: () => 0.1 },
      { truth: 0, low: 0.3, width: 0.5, effect: () => (random() < 0.5 ? 0.15 : -0.15) },
      { truth: -0.05, low: 0.9, width: 0.1, effect: () => -0.05 },
      { truth: 0.35, low: 0.3, width: 0.3, effect: () => 0.35 },
    ];
    const coverages = scenarios.map(({ truth, low, width, effect }) => {
      let hits = 0;
      for (let simulation = 0; simulation < SIMULATIONS; simulation += 1) {
        const differences = Array.from({ length: cases }, () => {
          const reference = low + width * random();
          const candidate = reference + effect();
          let first = 0;
          let second = 0;
          for (let repeat = 0; repeat < repeats; repeat += 1) {
            first += Number(random() < candidate);
            second += Number(random() < reference);
          }
          return (first - second) / repeats;
        });
        hits += Number(covers(bonettPriceClusterInterval(differences), truth));
      }
      return hits / SIMULATIONS;
    });
    const { mean, min } = summarize(coverages);
    expect(mean).toBeGreaterThanOrEqual(0.93);
    expect(mean).toBeLessThanOrEqual(0.99);
    expect(min).toBeGreaterThanOrEqual(0.9);
  });
});
