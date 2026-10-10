import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Canonical, verifyAuditLog, type AuditEvent } from "../../src/audit/log.js";
import { DEMO_MONITOR_CONFIG, DEMO_SEQUENCE, runSuspensionDemo } from "../../src/monitor/demo.js";
import { failureUpperBound, initialMonitorState, MonitorConfigSchema, recordOutcome, reenable, SuspensionMonitor, type MonitorConfig, type MonitorState, type Outcome } from "../../src/monitor/monitor.js";
import { wilsonInterval } from "../../src/stats/index.js";

const config: MonitorConfig = { ruleVersion: "suspension-rule-test-v1", windowSize: 20, minimumWindow: 10, maxFailureUpperBound: 0.4, confidence: 0.95 };
const outcomes = (flags: readonly boolean[]): Outcome[] => flags.map((failed, index) => ({ id: `o${index + 1}`, failed }));
const play = (flags: readonly boolean[], rule: MonitorConfig = config) => {
  let state: MonitorState = initialMonitorState();
  const transitions: { at: number; event: AuditEvent }[] = [];
  const rejected: number[] = [];
  for (const [index, outcome] of outcomes(flags).entries()) {
    const step = recordOutcome(state, outcome, rule);
    state = step.state;
    if (step.transition) transitions.push({ at: index + 1, event: step.transition });
    if (!step.accepted) rejected.push(index + 1);
  }
  return { state, transitions, rejected };
};
const ok = (count: number): boolean[] => Array<boolean>(count).fill(false);
const bad = (count: number): boolean[] => Array<boolean>(count).fill(true);

describe("suspension rule", () => {
  it("trips at the expected outcome of a scripted sequence", () => {
    // 12 successes then failures. One-sided 95% Wilson upper bounds: 1/13 = 28.2%, 2/14 = 35.3%, 3/15 = 40.9%.
    // The limit is 40%, so the monitor must suspend exactly at outcome 15.
    const { state, transitions, rejected } = play([...ok(12), ...bad(6)]);
    expect(transitions.map(({ at }) => at)).toEqual([15]);
    expect(state.status).toBe("SUSPENDED");
    expect(rejected).toEqual([16, 17, 18]);
    const { event } = transitions[0]!;
    expect(event).toMatchObject({ eventType: "suspended", ruleVersion: "suspension-rule-test-v1", details: { triggeredBy: "o15", windowLength: 15, failures: 3, limit: 0.4, confidence: 0.95 } });
    expect(event.details.failureUpperBound).toBeCloseTo(0.4088, 4);
    expect(event.details.failureUpperBound).toBe(wilsonInterval(3, 15, 0.95, "upper").high);
    expect(event.dataHashes.window).toBe(sha256Canonical(state.window));
    expect(wilsonInterval(2, 14, 0.95, "upper").high).toBeLessThan(0.4);
  });

  it("does not trip before the minimum window, however bad the start", () => {
    expect(play(bad(9)).state.status).toBe("ACTIVE");
    expect(play(bad(10)).transitions.map(({ at }) => at)).toEqual([10]);
    expect(play(bad(3), { ...config, minimumWindow: 3 }).transitions.map(({ at }) => at)).toEqual([3]);
  });

  it("stays active on a healthy stream and forgets failures that leave the window", () => {
    expect(play(ok(200)).state).toMatchObject({ status: "ACTIVE", window: { length: 20 } });
    const recovered = play([...ok(10), ...bad(2), ...ok(40)]);
    expect(recovered.transitions).toEqual([]);
    expect(recovered.state.window.every(({ failed }) => !failed)).toBe(true);
    expect(failureUpperBound([], 0.95)).toBeNull();
  });

  it("requires an explicit owner and reason to re-enable, and starts from a clean window", () => {
    const suspended = play([...ok(12), ...bad(3)]).state;
    expect(() => reenable(suspended, "   ", "fixed", config)).toThrow(/explicit owner/u);
    expect(() => reenable(suspended, "ana", "", config)).toThrow(/reason/u);
    expect(() => reenable(initialMonitorState(), "ana", "fixed", config)).toThrow(/Only a suspended monitor/u);
    const step = reenable(suspended, " ana ", " prompt rolled back ", config);
    expect(step.state).toEqual(initialMonitorState());
    expect(step.transition).toMatchObject({ eventType: "reenabled", ruleVersion: "suspension-rule-test-v1", details: { owner: "ana", reason: "prompt rolled back" }, dataHashes: { clearedWindow: sha256Canonical(suspended.window) } });
  });

  it("validates its configuration", () => {
    expect(() => MonitorConfigSchema.parse({ ...config, minimumWindow: 30 })).toThrow(/minimumWindow/u);
    expect(() => MonitorConfigSchema.parse({ ...config, maxFailureUpperBound: 1 })).toThrow();
    expect(() => new SuspensionMonitor({ ...config, windowSize: 0 }, { append: async () => undefined })).toThrow();
  });
});

describe("audited monitor", () => {
  it("writes each status change to the audit sink before changing state", async () => {
    const events: AuditEvent[] = [];
    const monitor = new SuspensionMonitor(config, { append: async (event) => { events.push(event); } });
    for (const outcome of outcomes([...ok(12), ...bad(3)])) await monitor.record(outcome);
    expect(monitor.status).toBe("SUSPENDED");
    expect((await monitor.record({ id: "late", failed: false })).accepted).toBe(false);
    await monitor.reenable("ana", "fixed");
    expect(monitor.status).toBe("ACTIVE");
    expect(events.map(({ eventType }) => eventType)).toEqual(["suspended", "reenabled"]);
  });

  it("stays active when the audit write fails, so no change goes unrecorded", async () => {
    const monitor = new SuspensionMonitor({ ...config, minimumWindow: 1, windowSize: 1 }, { append: async () => { throw new Error("disk full"); } });
    await expect(monitor.record({ id: "o1", failed: true })).rejects.toThrow("disk full");
    expect(monitor.status).toBe("ACTIVE");
  });

  it("runs the scripted demo end to end with a verifiable log", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "monitor-demo-")), "audit.jsonl");
    let tick = 0;
    const lines = await runSuspensionDemo(path, () => new Date(Date.UTC(2026, 9, 10, 0, 0, tick++)));
    expect(DEMO_SEQUENCE).toHaveLength(18);
    expect(lines[0]).toBe("outcome 15: SUSPENDED (failure upper bound 40.9% over limit 40%)");
    expect(lines.slice(1, 4)).toEqual(["outcome 16: rejected, monitor is suspended", "outcome 17: rejected, monitor is suspended", "outcome 18: rejected, monitor is suspended"]);
    expect(lines[4]).toBe("re-enabled by demo-owner: ACTIVE");
    expect(lines[5]).toMatch(/^audit log: 2 entries, verified, head [a-f0-9]{64}$/u);
    const text = await readFile(path, "utf8");
    expect(verifyAuditLog(text)).toMatchObject({ valid: true, entries: 2 });
    expect(text.trimEnd().split("\n").map((line) => (JSON.parse(line) as { eventType: string; ruleVersion: string }))).toMatchObject([
      { eventType: "suspended", ruleVersion: DEMO_MONITOR_CONFIG.ruleVersion },
      { eventType: "reenabled", ruleVersion: DEMO_MONITOR_CONFIG.ruleVersion },
    ]);
    expect(await runSuspensionDemo(path, () => new Date(Date.UTC(2026, 9, 10, 0, 0, tick++)))).toHaveLength(6);
  });
});
