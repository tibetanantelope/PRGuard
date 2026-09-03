const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
]

export function redactMemoryContent(content: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, '$1[REDACTED]'), content)
}

export function defaultMemoryTrust(source: 'human' | 'agent' | 'system', content?: string): 'untrusted' | 'observed' | 'human_verified' {
  if (content && isInstructionLikeMemory(content)) return 'untrusted'
  return source === 'human' ? 'human_verified' : 'observed'
}

export function isInstructionLikeMemory(content: string): boolean {
  return /ignore (all|previous) instructions|system prompt|reveal (the|your) (prompt|secret)|忽略(之前|所有)指令|泄露.*提示词/iu.test(content)
}
