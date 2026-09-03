import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isEnoentError } from './utils/errors.js'

export type MiniCodeSettings = {
  env?: Record<string, string | number>
  model?: string
  maxOutputTokens?: number
  mcpServers?: Record<string, McpServerConfig>
}

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string | number>
  url?: string
  headers?: Record<string, string | number>
  cwd?: string
  enabled?: boolean
  protocol?: 'auto' | 'content-length' | 'newline-json' | 'streamable-http'
}

export type RuntimeConfig = {
  model: string
  baseUrl: string
  authToken?: string
  apiKey?: string
  maxOutputTokens?: number
  mcpServers: Record<string, McpServerConfig>
  sourceSummary: string
  prGuardMySqlUrl?: string
  prGuardPostgresUrl?: string
  prGuardMemoryBackend?: 'jsonl' | 'postgres'
  prGuardEmbeddingDimensions?: number
  prGuardEmbeddingProvider?: 'hash' | 'remote'
  prGuardEmbeddingEndpoint?: string
  prGuardEmbeddingApiKey?: string
  prGuardEmbeddingModel?: string
  prGuardRedisUrl?: string
  prGuardRedisReclaimIdleMs?: number
  prGuardWorkerMetricsPort?: number
  prGuardMaxAttempts?: number
  prGuardReviewTimeoutMs?: number
  prGuardMaxSpecialists?: number
  prGuardOrchestrationMaxModelCalls?: number
  prGuardOrchestrationMaxInputTokens?: number
  prGuardOrchestrationMaxOutputTokens?: number
  prGuardOrchestrationMaxDurationMs?: number
  prGuardOrchestrationMaxConcurrentAgents?: number
  prGuardCriticJudgeEnabled?: boolean
  prGuardVerificationTimeoutMs?: number
  prGuardSandboxMode?: 'local' | 'docker'
  prGuardSandboxImage?: string
  prGuardSandboxMemoryMb?: number
  prGuardSandboxCpus?: number
  prGuardSandboxPidsLimit?: number
  prGuardSandboxMaxOutputBytes?: number
  prGuardPatchMaxBytes?: number
  prGuardPatchMaxFiles?: number
  prGuardGithubToken?: string
  prGuardGithubWebhookSecret?: string
  prGuardGithubWorkspace?: string
  prGuardGithubFeedbackEnabled?: boolean
  prGuardApiKey?: string
  prGuardRbacJson?: string
  prGuardRateLimitPerMinute?: number
}

export type McpConfigScope = 'user' | 'project'

export const MINI_CODE_DIR = process.env.MINI_CODE_HOME
  ? path.resolve(process.env.MINI_CODE_HOME)
  : path.join(os.homedir(), '.mini-code')
export const MINI_CODE_SETTINGS_PATH = path.join(MINI_CODE_DIR, 'settings.json')
export const MINI_CODE_HISTORY_PATH = path.join(MINI_CODE_DIR, 'history.jsonl')
export const MINI_CODE_PERMISSIONS_PATH = path.join(MINI_CODE_DIR, 'permissions.json')
export const MINI_CODE_MCP_PATH = path.join(MINI_CODE_DIR, 'mcp.json')
export const MINI_CODE_MCP_TOKENS_PATH = path.join(MINI_CODE_DIR, 'mcp-tokens.json')
export const MINI_CODE_PROJECTS_DIR = path.join(MINI_CODE_DIR, 'projects')
export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
export const PROJECT_MCP_PATH = path.join(process.cwd(), '.mcp.json')
export const PROJECT_ENV_PATH = path.join(process.cwd(), '.env')

function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const assignment = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!assignment) continue

    let value = assignment[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }

    values[assignment[1]] = value
  }

  return values
}

function parsePositiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parsePositiveNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function readDotEnvFile(filePath = PROJECT_ENV_PATH): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (isEnoentError(error)) return {}
    throw error
  }
}

export async function readMcpTokensFile(
  filePath = MINI_CODE_MCP_TOKENS_PATH,
): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    return parsed as Record<string, string>
  } catch (error) {
    if (isEnoentError(error)) return {}
    throw error
  }
}

export async function saveMcpTokensFile(
  tokens: Record<string, string>,
  filePath = MINI_CODE_MCP_TOKENS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
}

async function readSettingsFile(filePath: string): Promise<MiniCodeSettings> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as MiniCodeSettings
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export async function readMcpConfigFile(
  filePath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('mcpServers' in parsed) ||
      typeof parsed.mcpServers !== 'object' ||
      parsed.mcpServers === null
    ) {
      return {}
    }

    return parsed.mcpServers as Record<string, McpServerConfig>
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export function getMcpConfigPath(
  scope: McpConfigScope,
  cwd = process.cwd(),
): string {
  return scope === 'project' ? path.join(cwd, '.mcp.json') : MINI_CODE_MCP_PATH
}

export async function loadScopedMcpServers(
  scope: McpConfigScope,
  cwd = process.cwd(),
): Promise<Record<string, McpServerConfig>> {
  return readMcpConfigFile(getMcpConfigPath(scope, cwd))
}

export async function saveScopedMcpServers(
  scope: McpConfigScope,
  servers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<void> {
  const targetPath = getMcpConfigPath(scope, cwd)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(
    targetPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    'utf8',
  )
}

function mergeSettings(
  base: MiniCodeSettings,
  override: MiniCodeSettings,
): MiniCodeSettings {
  const mergedMcpServers = {
    ...(base.mcpServers ?? {}),
  }

  for (const [name, server] of Object.entries(override.mcpServers ?? {})) {
    mergedMcpServers[name] = {
      ...(mergedMcpServers[name] ?? {}),
      ...server,
      env: {
        ...(mergedMcpServers[name]?.env ?? {}),
        ...(server.env ?? {}),
      },
      headers: {
        ...(mergedMcpServers[name]?.headers ?? {}),
        ...(server.headers ?? {}),
      },
    }
  }

  return {
    ...base,
    ...override,
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {}),
    },
    mcpServers: mergedMcpServers,
  }
}

export async function loadEffectiveSettings(): Promise<MiniCodeSettings> {
  const [claudeSettings, globalMcpConfig, projectMcpConfig, miniCodeSettings] =
    await Promise.all([
      readSettingsFile(CLAUDE_SETTINGS_PATH),
      readMcpConfigFile(MINI_CODE_MCP_PATH),
      readMcpConfigFile(PROJECT_MCP_PATH),
      readSettingsFile(MINI_CODE_SETTINGS_PATH),
    ])
  return mergeSettings(
    mergeSettings(
      mergeSettings(claudeSettings, { mcpServers: globalMcpConfig }),
      { mcpServers: projectMcpConfig },
    ),
    miniCodeSettings,
  )
}

export async function saveMiniCodeSettings(
  updates: MiniCodeSettings,
): Promise<void> {
  await mkdir(MINI_CODE_DIR, { recursive: true })
  const existing = await readSettingsFile(MINI_CODE_SETTINGS_PATH)
  const next = mergeSettings(existing, updates)
  await writeFile(
    MINI_CODE_SETTINGS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  )
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const effectiveSettings = await loadEffectiveSettings()
  const dotEnv = await readDotEnvFile()
  const env = {
    ...(effectiveSettings.env ?? {}),
    ...dotEnv,
    ...process.env,
  }

  const model =
    process.env.MINI_CODE_MODEL ||
    String(env.MINI_CODE_MODEL ?? '').trim() ||
    effectiveSettings.model ||
    String(env.ANTHROPIC_MODEL ?? '').trim()

  const baseUrl =
    String(env.ANTHROPIC_BASE_URL ?? '').trim() || 'https://api.anthropic.com'
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN ?? '').trim() || undefined
  const apiKey = String(env.ANTHROPIC_API_KEY ?? '').trim() || undefined
  const prGuardMySqlUrl = String(env.PR_GUARD_MYSQL_URL ?? '').trim() || undefined
  const prGuardPostgresUrl = String(env.PR_GUARD_POSTGRES_URL ?? '').trim() || undefined
  const memoryBackendValue = String(env.PR_GUARD_MEMORY_BACKEND ?? 'jsonl').trim().toLowerCase()
  if (memoryBackendValue !== 'jsonl' && memoryBackendValue !== 'postgres') {
    throw new Error('PR_GUARD_MEMORY_BACKEND must be jsonl or postgres.')
  }
  const prGuardMemoryBackend = memoryBackendValue
  const prGuardEmbeddingDimensions = parsePositiveInteger(env.PR_GUARD_EMBEDDING_DIMENSIONS, 1536)
  const embeddingProviderValue = String(env.PR_GUARD_EMBEDDING_PROVIDER ?? 'hash').trim().toLowerCase()
  if (embeddingProviderValue !== 'hash' && embeddingProviderValue !== 'remote') {
    throw new Error('PR_GUARD_EMBEDDING_PROVIDER must be hash or remote.')
  }
  const prGuardEmbeddingProvider = embeddingProviderValue
  const prGuardEmbeddingEndpoint = String(env.PR_GUARD_EMBEDDING_ENDPOINT ?? '').trim() || undefined
  const prGuardEmbeddingApiKey = String(env.PR_GUARD_EMBEDDING_API_KEY ?? '').trim() || undefined
  const prGuardEmbeddingModel = String(env.PR_GUARD_EMBEDDING_MODEL ?? '').trim() || undefined
  const prGuardRedisUrl = String(env.PR_GUARD_REDIS_URL ?? '').trim() || undefined
  const prGuardRedisReclaimIdleMs = parsePositiveInteger(env.PR_GUARD_REDIS_RECLAIM_IDLE_MS, 30_000)
  const prGuardWorkerMetricsPort = parsePositiveInteger(env.PR_GUARD_WORKER_METRICS_PORT, 9091)
  const prGuardMaxAttempts = parsePositiveInteger(env.PR_GUARD_MAX_ATTEMPTS, 3)
  const prGuardReviewTimeoutMs = parsePositiveInteger(env.PR_GUARD_REVIEW_TIMEOUT_MS, 120_000)
  const prGuardMaxSpecialists = parsePositiveInteger(env.PR_GUARD_MAX_SPECIALISTS, 3)
  const prGuardOrchestrationMaxModelCalls = parsePositiveInteger(env.PR_GUARD_ORCHESTRATION_MAX_MODEL_CALLS, 74)
  const prGuardOrchestrationMaxInputTokens = parsePositiveInteger(env.PR_GUARD_ORCHESTRATION_MAX_INPUT_TOKENS, 300_000)
  const prGuardOrchestrationMaxOutputTokens = parsePositiveInteger(env.PR_GUARD_ORCHESTRATION_MAX_OUTPUT_TOKENS, 50_000)
  const prGuardOrchestrationMaxDurationMs = parsePositiveInteger(env.PR_GUARD_ORCHESTRATION_MAX_DURATION_MS, 360_000)
  const prGuardOrchestrationMaxConcurrentAgents = parsePositiveInteger(env.PR_GUARD_ORCHESTRATION_MAX_CONCURRENT_AGENTS, 3)
  const prGuardCriticJudgeEnabled = String(env.PR_GUARD_CRITIC_JUDGE_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
  const prGuardVerificationTimeoutMs = parsePositiveInteger(env.PR_GUARD_VERIFICATION_TIMEOUT_MS, 120_000)
  const sandboxModeValue = String(env.PR_GUARD_SANDBOX_MODE ?? 'docker').trim().toLowerCase()
  if (sandboxModeValue !== 'local' && sandboxModeValue !== 'docker') {
    throw new Error('PR_GUARD_SANDBOX_MODE must be local or docker.')
  }
  const prGuardSandboxMode = sandboxModeValue
  const prGuardSandboxImage = String(env.PR_GUARD_SANDBOX_IMAGE ?? 'node:22-alpine').trim()
  const prGuardSandboxMemoryMb = parsePositiveInteger(env.PR_GUARD_SANDBOX_MEMORY_MB, 512)
  const prGuardSandboxCpus = parsePositiveNumber(env.PR_GUARD_SANDBOX_CPUS, 1)
  const prGuardSandboxPidsLimit = parsePositiveInteger(env.PR_GUARD_SANDBOX_PIDS_LIMIT, 128)
  const prGuardSandboxMaxOutputBytes = parsePositiveInteger(env.PR_GUARD_SANDBOX_MAX_OUTPUT_BYTES, 1024 * 1024)
  const prGuardPatchMaxBytes = parsePositiveInteger(env.PR_GUARD_PATCH_MAX_BYTES, 1024 * 1024)
  const prGuardPatchMaxFiles = parsePositiveInteger(env.PR_GUARD_PATCH_MAX_FILES, 100)
  const prGuardGithubToken = String(env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '').trim() || undefined
  const prGuardGithubWebhookSecret = String(env.PR_GUARD_GITHUB_WEBHOOK_SECRET ?? '').trim() || undefined
  const prGuardGithubWorkspace = String(env.PR_GUARD_GITHUB_WORKSPACE ?? '').trim() || undefined
  const prGuardGithubFeedbackEnabled = String(env.PR_GUARD_GITHUB_FEEDBACK_ENABLED ?? '').trim().toLowerCase() === 'true'
  const prGuardApiKey = String(env.PR_GUARD_API_KEY ?? '').trim() || undefined
  const prGuardRbacJson = String(env.PR_GUARD_RBAC_JSON ?? '').trim() || undefined
  const prGuardRateLimitPerMinute = parsePositiveInteger(env.PR_GUARD_RATE_LIMIT_PER_MINUTE, 120)
  const rawMaxOutputTokens =
    process.env.MINI_CODE_MAX_OUTPUT_TOKENS ??
    effectiveSettings.maxOutputTokens ??
    env.MINI_CODE_MAX_OUTPUT_TOKENS
  const parsedMaxOutputTokens =
    rawMaxOutputTokens === undefined ? NaN : Number(rawMaxOutputTokens)
  const maxOutputTokens =
    Number.isFinite(parsedMaxOutputTokens) && parsedMaxOutputTokens > 0
      ? Math.floor(parsedMaxOutputTokens)
      : undefined

  if (!model) {
    throw new Error(
      `No model configured. Set .env, ~/.mini-code/settings.json, or env.ANTHROPIC_MODEL.`,
    )
  }

  if (!authToken && !apiKey) {
    throw new Error(
      `No auth configured. Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in .env, ~/.mini-code/settings.json, or process env.`,
    )
  }

  return {
    model,
    baseUrl,
    authToken,
    apiKey,
    maxOutputTokens,
    mcpServers: effectiveSettings.mcpServers ?? {},
    sourceSummary: `config: ${PROJECT_ENV_PATH} > ${MINI_CODE_SETTINGS_PATH} > ${CLAUDE_SETTINGS_PATH} > process.env`,
    prGuardMySqlUrl,
    prGuardPostgresUrl,
    prGuardMemoryBackend,
    prGuardEmbeddingDimensions,
    prGuardEmbeddingProvider,
    prGuardEmbeddingEndpoint,
    prGuardEmbeddingApiKey,
    prGuardEmbeddingModel,
    prGuardRedisUrl,
    prGuardRedisReclaimIdleMs,
    prGuardWorkerMetricsPort,
    prGuardMaxAttempts,
    prGuardReviewTimeoutMs,
    prGuardMaxSpecialists,
    prGuardOrchestrationMaxModelCalls,
    prGuardOrchestrationMaxInputTokens,
    prGuardOrchestrationMaxOutputTokens,
    prGuardOrchestrationMaxDurationMs,
    prGuardOrchestrationMaxConcurrentAgents,
    prGuardCriticJudgeEnabled,
    prGuardVerificationTimeoutMs,
    prGuardSandboxMode,
    prGuardSandboxImage,
    prGuardSandboxMemoryMb,
    prGuardSandboxCpus,
    prGuardSandboxPidsLimit,
    prGuardSandboxMaxOutputBytes,
    prGuardPatchMaxBytes,
    prGuardPatchMaxFiles,
    prGuardGithubToken,
    prGuardGithubWebhookSecret,
    prGuardGithubWorkspace,
    prGuardGithubFeedbackEnabled,
    prGuardApiKey,
    prGuardRbacJson,
    prGuardRateLimitPerMinute,
  }
}
