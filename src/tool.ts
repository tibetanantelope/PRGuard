import { z } from 'zod'
import type { PermissionManager } from './permissions.js'
import type { SkillSummary } from './skills.js'
import type { McpServerSummary } from './mcp.js'
import { throwIfAborted } from './abort.js'

export type ToolContext = {
  cwd: string
  permissions?: PermissionManager
  signal?: AbortSignal
}

export type BackgroundTaskResult = {
  taskId: string
  type: 'local_bash'
  command: string
  pid: number
  status: 'running' | 'completed' | 'failed'
  startedAt: number
}

export type ToolResult = {
  ok: boolean
  output: string
  backgroundTask?: BackgroundTaskResult
  awaitUser?: boolean
}

export type ToolRisk = 'read_only' | 'state_changing' | 'external_side_effect'

export type ToolExecutionPolicy = {
  defaultTimeoutMs?: number
  maxOutputChars?: number
  allowExternalSideEffects?: boolean
}

export type ToolDefinition<TInput> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schema: z.ZodType<TInput>
  risk?: ToolRisk
  timeoutMs?: number
  run(input: TInput, context: ToolContext): Promise<ToolResult>
}

type ToolRegistryMetadata = {
  skills?: SkillSummary[]
  mcpServers?: McpServerSummary[]
}

export class ToolRegistry {
  private readonly toolsStore: ToolDefinition<unknown>[]
  private metadataStore: ToolRegistryMetadata
  private readonly disposers: Array<() => Promise<void>> = []
  private readonly policy: ToolExecutionPolicy

  constructor(
    tools: ToolDefinition<unknown>[],
    metadata: ToolRegistryMetadata = {},
    disposer?: () => Promise<void>,
    policy: ToolExecutionPolicy = {},
  ) {
    this.toolsStore = [...tools]
    this.metadataStore = metadata
    this.policy = { ...policy }
    if (disposer) {
      this.disposers.push(disposer)
    }
  }

  list(): ToolDefinition<unknown>[] {
    return this.toolsStore
  }

  subset(names: readonly string[]): ToolRegistry {
    const allowedNames = new Set(names)
    return new ToolRegistry(
      this.toolsStore.filter(tool => allowedNames.has(tool.name)),
      {},
      undefined,
      this.policy,
    )
  }

  getSkills(): SkillSummary[] {
    return this.metadataStore.skills ?? []
  }

  getMcpServers(): McpServerSummary[] {
    return this.metadataStore.mcpServers ?? []
  }

  setMcpServers(servers: McpServerSummary[]): void {
    this.metadataStore = {
      ...this.metadataStore,
      mcpServers: [...servers],
    }
  }

  addTools(nextTools: ToolDefinition<unknown>[]): void {
    const existingNames = new Set(this.toolsStore.map(tool => tool.name))
    for (const tool of nextTools) {
      if (existingNames.has(tool.name)) {
        continue
      }
      this.toolsStore.push(tool)
      existingNames.add(tool.name)
    }
  }

  addDisposer(disposer: () => Promise<void>): void {
    this.disposers.push(disposer)
  }

  find(name: string): ToolDefinition<unknown> | undefined {
    return this.toolsStore.find(tool => tool.name === name)
  }

  manifest(): Array<{ name: string; risk: ToolRisk; timeoutMs?: number }> {
    return this.toolsStore.map(tool => ({
      name: tool.name,
      risk: tool.risk ?? inferToolRisk(tool.name),
      timeoutMs: tool.timeoutMs ?? this.policy.defaultTimeoutMs,
    }))
  }

  riskFor(name: string): ToolRisk {
    const tool = this.find(name)
    return tool?.risk ?? inferToolRisk(name)
  }

  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.find(toolName)
    if (!tool) {
      return {
        ok: false,
        output: `Unknown tool: ${toolName}`,
      }
    }

    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        output: parsed.error.message,
      }
    }

    const risk = tool.risk ?? inferToolRisk(tool.name)
    if (risk === 'external_side_effect' && this.policy.allowExternalSideEffects === false) {
      return { ok: false, output: `Tool blocked by execution policy: ${toolName}` }
    }

    const controller = new AbortController()
    const forwardAbort = () => controller.abort(context.signal?.reason)
    context.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeoutMs = tool.timeoutMs ?? this.policy.defaultTimeoutMs
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs)
    try {
      throwIfAborted(context.signal)
      const result = await tool.run(parsed.data, { ...context, signal: controller.signal })
      throwIfAborted(context.signal)
      if (this.policy.maxOutputChars !== undefined && result.output.length > this.policy.maxOutputChars) {
        return { ...result, output: `${result.output.slice(0, this.policy.maxOutputChars)}\n[tool output truncated by policy]` }
      }
      return result
    } catch (error) {
      if (context.signal?.aborted) throw error
      if (controller.signal.aborted && timeout !== undefined) return { ok: false, output: `Tool timed out after ${timeoutMs}ms` }
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      context.signal?.removeEventListener('abort', forwardAbort)
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(this.disposers.map(disposer => disposer()))
  }
}

function inferToolRisk(name: string): ToolRisk {
  if (/^(write|edit|modify|patch|run_command|spawn|close|apply|delete)/i.test(name)) return 'state_changing'
  if (/publish|send|post|webhook|external/i.test(name)) return 'external_side_effect'
  return 'read_only'
}
