import http from 'node:http'
import type { PrGuardTraceEvent } from './trace.js'
import { redactSensitiveValue } from './redaction.js'

type Labels = Record<string, string>

function key(name: string, labels: Labels): string {
  return `${name}{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`
}

export class PrGuardMetrics {
  private readonly counters = new Map<string, { name: string; labels: Labels; value: number }>()
  private readonly histograms = new Map<string, { name: string; labels: Labels; count: number; sum: number }>()
  private readonly gauges = new Map<string, { name: string; labels: Labels; value: number }>()

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

  set(name: string, value: number, labels: Labels = {}): void {
    this.gauges.set(key(name, labels), { name, labels, value: Math.max(0, value) })
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
    for (const metric of this.gauges.values()) {
      lines.push(`${metric.name}${formatLabels(metric.labels)} ${metric.value}`)
    }
    return `${lines.join('\n')}\n`
  }
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels)
  return entries.length === 0 ? '' : `{${entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(',')}}`
}

export const prGuardMetrics = new PrGuardMetrics()

export async function startPrGuardMetricsServer(
  options: { host?: string; port?: number } = {},
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      const payload = prGuardMetrics.renderPrometheus()
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      res.setHeader('content-length', Buffer.byteLength(payload))
      res.end(payload)
      return
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ status: 'ok', service: 'prguard-worker-metrics' }))
      return
    }
    res.statusCode = 404
    res.end('Not found')
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port ?? 9091, options.host ?? '127.0.0.1')
  })
  return server
}

export function logPrGuardEvent(event: string, fields: Record<string, unknown> = {}): void {
  // One JSON object per line makes the service logs ingestible by Loki, ELK, or a shell pipeline.
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: 'prguard', event, ...redactSensitiveValue(fields) as Record<string, unknown> }))
}
