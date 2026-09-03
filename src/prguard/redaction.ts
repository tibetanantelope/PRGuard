import type { ReviewResult } from './types.js'

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED_API_KEY]')
    .replace(/((?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

export function redactSensitiveValue(value: unknown, fieldName = ''): unknown {
  if (/(authorization|api[-_]?key|password|secret|token)/i.test(fieldName)) return '[REDACTED]'
  if (typeof value === 'string') return redactSensitiveText(value)
  if (Array.isArray(value)) return value.map(item => redactSensitiveValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, nested]) => [name, redactSensitiveValue(nested, name)]))
  }
  return value
}

export function redactReviewResult(result: ReviewResult): ReviewResult {
  return redactSensitiveValue(result) as ReviewResult
}

export function escapeUntrustedPromptContent(value: string): string {
  return value.replace(/<\/?(?:untrusted-diff|trusted-instructions)>/gi, match => match.replaceAll('<', '&lt;').replaceAll('>', '&gt;'))
}
