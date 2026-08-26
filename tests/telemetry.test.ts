import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { CompositeTelemetrySink, JsonlTelemetrySink, NoopTelemetrySink, createLangfuseTelemetry, maskSecrets } from "../src/telemetry.js";

describe("telemetry", () => {
  it("is a no-op without complete credentials", async () => {
    expect(await createLangfuseTelemetry({}, vi.fn())).toBeInstanceOf(NoopTelemetrySink);
  });

  it("masks nested credentials", () => {
    expect(maskSecrets({ metadata: { apiKey: "bad", safe: "ok" } })).toEqual({
      metadata: { apiKey: "[REDACTED]", safe: "ok" },
    });
  });

  it("loads Langfuse only when configured and flushes", async () => {
    const forceFlush = vi.fn().mockResolvedValue(undefined);
    class LangfuseSpanProcessor { forceFlush = forceFlush; }
    class NodeTracerProvider {
      register() {}
      getTracer() { return { startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }) }; }
    }
    const sink = await createLangfuseTelemetry(
      { LANGFUSE_PUBLIC_KEY: "p", LANGFUSE_SECRET_KEY: "s", LANGFUSE_BASE_URL: "https://x" },
      vi.fn(async (specifier: string) => specifier === "@langfuse/otel"
        ? { LangfuseSpanProcessor }
        : specifier.includes("sdk-trace")
          ? { NodeTracerProvider }
          : { trace: { setSpan: vi.fn() }, context: { active: vi.fn() } }),
    );
    await sink.emit({ sequence: 1, type: "model", at: "2026-01-01T00:00:00.000Z", payload: { runId: "r1", name: "generation", tokens: 3 } });
    await sink.emit({ sequence: 2, type: "complete", at: "2026-01-01T00:00:01.000Z", payload: { runId: "r1" } });
    await sink.flush();
    expect(forceFlush).toHaveBeenCalledOnce();
  });

  it("persists masked JSONL events and composes sinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-telemetry-"));
    const path = join(directory, "events.jsonl");
    const jsonl = new JsonlTelemetrySink(path);
    const noop = new NoopTelemetrySink();
    const sink = new CompositeTelemetrySink([jsonl, noop]);
    await sink.emit({ sequence: 1, type: "tool", at: "2026-01-01T00:00:00.000Z", payload: { apiKey: "hidden", name: "get_document" } });
    await sink.flush();
    expect(await readFile(path, "utf8")).toContain("[REDACTED]");
    await rm(directory, { recursive: true });
  });
});
