import type { PrGuardTraceEvent } from './trace.js'

type Labels = Record<string, string>

function key(name: string, labels: Labels): string {
  return `${name}{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`
}

export class PrGuardMetrics {
  private readonly counters = new Map<string, { name: string; labels: Labels; value: number }>()
  private readonly histograms = new Map<string, { name: string; labels: Labels; count: number; sum: number }>()

  increment(name: string, labels: Labels = {}, value = 1): void {
    const id = key(name, labels)
    const metric = this.counters.get(id) ?? { name, labels, value: 0 }
    metric.value += value
    this.counters.set(id, metric)
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const id = key(name, labels)
    const metric = this.histograms.get(id) ?? { name, labels, count: 0, sum: 0 }
    metric.count += 1
    metric.sum += Math.max(0, value)
    this.histograms.set(id, metric)
  }

  recordTrace(events: PrGuardTraceEvent[]): void {
    for (const event of events) {
      if (event.type === 'model_response') {
        this.increment('prguard_model_requests_total', { status: 'success' })
        const usage = event.payload.usage
        if (usage && typeof usage === 'object') {
          const input = Number((usage as Record<string, unknown>).inputTokens ?? 0)
          const output = Number((usage as Record<string, unknown>).outputTokens ?? 0)
          this.increment('prguard_model_tokens_total', { direction: 'input' }, Number.isFinite(input) ? input : 0)
          this.increment('prguard_model_tokens_total', { direction: 'output' }, Number.isFinite(output) ? output : 0)
        }
        const duration = Number(event.payload.durationMs)
        if (Number.isFinite(duration)) this.observe('prguard_model_request_duration_ms', duration)
      }
      if (event.type === 'tool_finished') {
        this.increment('prguard_tool_calls_total', { tool: String(event.payload.toolName ?? 'unknown'), status: event.payload.ok === false ? 'error' : 'success' })
        const duration = Number(event.payload.durationMs)
        if (Number.isFinite(duration)) this.observe('prguard_tool_duration_ms', duration, { tool: String(event.payload.toolName ?? 'unknown') })
      }
    }
  }

  renderPrometheus(): string {
    const lines: string[] = []
    for (const metric of this.counters.values()) {
      lines.push(`${metric.name}${formatLabels(metric.labels)} ${metric.value}`)
    }
    for (const metric of this.histograms.values()) {
      lines.push(`${metric.name}_count${formatLabels(metric.labels)} ${metric.count}`)
      lines.push(`${metric.name}_sum${formatLabels(metric.labels)} ${metric.sum}`)
    }
    return `${lines.join('\n')}\n`
  }
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels)
  return entries.length === 0 ? '' : `{${entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(',')}}`
}

export const prGuardMetrics = new PrGuardMetrics()

export function logPrGuardEvent(event: string, fields: Record<string, unknown> = {}): void {
  // One JSON object per line makes the service logs ingestible by Loki, ELK, or a shell pipeline.
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: 'prguard', event, ...redactFields(fields) }))
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) =>
    /(token|secret|password|authorization|api[-_]?key)/i.test(name)
      ? [name, '[REDACTED]']
      : [name, value],
  ))
}
