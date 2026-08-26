import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunnerEvent, TelemetrySink } from "./contracts.js";

export class NoopTelemetrySink implements TelemetrySink {
  async emit(): Promise<void> {}
  async flush(): Promise<void> {}
}

export class JsonlTelemetrySink implements TelemetrySink {
  constructor(private readonly path: string) {}

  async emit(event: RunnerEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(maskSecrets(event))}\n`, "utf8");
  }

  async flush(): Promise<void> {}
}

const SECRET_KEY = /(api[-_]?key|authorization|cookie|password|secret|token)$/i;

export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : maskSecrets(item),
      ]),
    ) as T;
  }
  return value;
}

type OtelSpan = { setAttribute(name: string, value: string | number | boolean): void; end(): void };
type OtelTracer = { startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }, context?: unknown): OtelSpan };
type OtelProcessor = { forceFlush(): Promise<void> };

export class LangfuseTelemetrySink implements TelemetrySink {
  private readonly roots = new Map<string, OtelSpan>();
  constructor(
    private readonly tracer: OtelTracer,
    private readonly processor: OtelProcessor,
    private readonly childContext: (span: OtelSpan) => unknown,
  ) {}

  async emit(event: RunnerEvent): Promise<void> {
    const safe = maskSecrets(event);
    const runId = typeof safe.payload.runId === "string" ? safe.payload.runId : `run-${safe.sequence}`;
    const eventName = typeof safe.payload.name === "string" ? safe.payload.name : safe.type;
    let root = this.roots.get(runId);
    if (!root) {
      root = this.tracer.startSpan("evaluation-case", { attributes: { "eval.run.id": runId, "eval.synthetic": true } });
      this.roots.set(runId, root);
    }
    const span = this.tracer.startSpan(`${safe.type}:${eventName}`, { attributes: telemetryAttributes(safe.payload) }, this.childContext(root));
    span.end();
    if (safe.type === "score") {
      root.end();
      this.roots.delete(runId);
    }
  }

  async flush(): Promise<void> {
    for (const root of this.roots.values()) root.end();
    this.roots.clear();
    await this.processor.forceFlush();
  }
}

export type LangfuseEnvironment = Readonly<Record<string, string | undefined>>;

export async function createLangfuseTelemetry(
  environment: LangfuseEnvironment = process.env,
  loader: (specifier: string) => Promise<Record<string, unknown>> = async (specifier) => import(specifier),
): Promise<TelemetrySink> {
  if (
    !environment.LANGFUSE_PUBLIC_KEY ||
    !environment.LANGFUSE_SECRET_KEY ||
    !environment.LANGFUSE_BASE_URL
  ) {
    return new NoopTelemetrySink();
  }
  const [langfuse, sdk, api] = await Promise.all([
    loader("@langfuse/otel"),
    loader("@opentelemetry/sdk-trace-node"),
    loader("@opentelemetry/api"),
  ]);
  const Processor = langfuse.LangfuseSpanProcessor as (new (options: Record<string, unknown>) => OtelProcessor) | undefined;
  const Provider = sdk.NodeTracerProvider as (new (options: Record<string, unknown>) => { register(): void; getTracer(name: string): OtelTracer }) | undefined;
  const traceApi = api.trace as { setSpan(context: unknown, span: OtelSpan): unknown } | undefined;
  const contextApi = api.context as { active(): unknown } | undefined;
  if (!Processor || !Provider || !traceApi || !contextApi) throw new Error("Incomplete OpenTelemetry installation");
  const processor = new Processor({
    publicKey: environment.LANGFUSE_PUBLIC_KEY,
    secretKey: environment.LANGFUSE_SECRET_KEY,
    baseUrl: environment.LANGFUSE_BASE_URL,
    exportMode: "immediate",
    mask: ({ data }: { data: unknown }) => maskSecrets(data),
  });
  const provider = new Provider({ spanProcessors: [processor] });
  provider.register();
  return new LangfuseTelemetrySink(provider.getTracer("ai-reliability-eval-lab"), processor, (span) => traceApi.setSpan(contextApi.active(), span));
}

function telemetryAttributes(payload: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    `eval.${key}`,
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value),
  ]));
}

export class CompositeTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: readonly TelemetrySink[]) {}

  async emit(event: RunnerEvent): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.emit(event)));
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.flush()));
  }
}
