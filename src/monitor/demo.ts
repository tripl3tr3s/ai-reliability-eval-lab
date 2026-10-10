import { rm } from "node:fs/promises";
import { AuditLog } from "../audit/log.js";
import { SuspensionMonitor, type MonitorConfig } from "./monitor.js";

export const DEMO_MONITOR_CONFIG: MonitorConfig = {
  ruleVersion: "suspension-rule-demo-v1",
  windowSize: 20,
  minimumWindow: 10,
  maxFailureUpperBound: 0.4,
  confidence: 0.95,
};

/** 12 successes followed by failures: enough to show ACTIVE, the trip to SUSPENDED, and rejected outcomes. */
export const DEMO_SEQUENCE: readonly boolean[] = [...Array<boolean>(12).fill(false), ...Array<boolean>(6).fill(true)];

/**
 * Scripted walk through the pattern: outcomes arrive, the monitor suspends, an owner re-enables it,
 * and the audit log verifies. Replaces any previous log at the path so the demo is repeatable.
 */
export async function runSuspensionDemo(logPath: string, now: () => Date = () => new Date()): Promise<readonly string[]> {
  await rm(logPath, { force: true });
  const audit = new AuditLog(logPath, now);
  const monitor = new SuspensionMonitor(DEMO_MONITOR_CONFIG, audit);
  const lines: string[] = [];
  for (const [index, failed] of DEMO_SEQUENCE.entries()) {
    const step = await monitor.record({ id: `outcome-${index + 1}`, failed });
    if (step.transition) lines.push(`outcome ${index + 1}: SUSPENDED (failure upper bound ${(Number(step.transition.details.failureUpperBound) * 100).toFixed(1)}% over limit ${(DEMO_MONITOR_CONFIG.maxFailureUpperBound * 100).toFixed(0)}%)`);
    else if (!step.accepted) lines.push(`outcome ${index + 1}: rejected, monitor is suspended`);
  }
  await monitor.reenable("demo-owner", "Root cause fixed and verified in mock mode");
  lines.push(`re-enabled by demo-owner: ${monitor.status}`);
  const verification = await audit.verify();
  lines.push(`audit log: ${verification.entries} entries, ${verification.valid ? "verified" : "FAILED verification"}, head ${verification.headHash}`);
  return lines;
}
