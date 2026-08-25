import {
  type McpConfigScope,
  type McpServerConfig,
  MINI_CODE_MCP_TOKENS_PATH,
  getMcpConfigPath,
  loadScopedMcpServers,
  loadRuntimeConfig,
  readMcpTokensFile,
  saveMcpTokensFile,
  saveScopedMcpServers,
} from './config.js'
import { discoverSkills, installSkill, removeManagedSkill } from './skills.js'
import {
  formatDiffSnapshot,
  formatReviewResult,
  loadGithubPrDiffSnapshot,
  loadPrDiffSnapshot,
} from './prguard/index.js'
import {
  formatPatch,
} from './prguard/index.js'
import { reviewResultSchema } from './prguard/index.js'
import { EvaluationService, RepairService, ReviewService, TraceService } from './prguard/services.js'
import { startPrGuardServer } from './prguard/http.js'
import { ReviewJobService, ReviewWorker } from './prguard/jobs.js'
import { createInterface } from 'node:readline/promises'
import process from 'node:process'

function printUsage(): void {
  console.log(`minicode management commands

minicode mcp list [--project]
minicode mcp add <name> [--project] [--protocol <auto|content-length|newline-json|streamable-http>] [--url <endpoint>] [--header KEY=VALUE ...] [--env KEY=VALUE ...] [-- <command> [args...]]
minicode mcp login <name> --token <bearer-token>
minicode mcp logout <name>
minicode mcp remove <name> [--project]

minicode skills list
minicode skills add <path-to-skill-or-dir> [--name <name>] [--project]
minicode skills remove <name> [--project]

minicode pr review --base <git-ref> [--head <git-ref>] [--test-command <cmd>] [--multi-agent] [--json] [--preview]
minicode pr review --diff <path> [--github <owner/repo#number>] [--test-command <cmd>] [--multi-agent] [--json] [--preview]
minicode pr repair --base <git-ref> --finding <id> --test-command <cmd> [--head <git-ref>] [--review-run <run-id>] [--json]
minicode pr trace list
minicode pr trace show <run-id>
minicode pr trace replay <run-id>
minicode pr trace resume <run-id> [--multi-agent]
minicode pr eval [--dataset <tasks.jsonl>] [--baseline | --predictions <file>] [--json]
GitHub PR reviews can use --github owner/repo#123 or https://github.com/owner/repo/pull/123.
minicode pr serve [--host <host>] [--port <port>]
minicode pr worker`)
}

function parseScope(args: string[]): {
  scope: McpConfigScope
  rest: string[]
} {
  const rest = [...args]
  const projectIndex = rest.indexOf('--project')
  if (projectIndex !== -1) {
    rest.splice(projectIndex, 1)
    return { scope: 'project', rest }
  }
  return { scope: 'user', rest }
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value) {
    throw new Error(`Missing value for ${name}`)
  }
  args.splice(index, 2)
  return value
}

function takeRepeatOption(args: string[], name: string): string[] {
  const values: string[] = []
  while (true) {
    const index = args.indexOf(name)
    if (index === -1) break
    const value = args[index + 1]
    if (!value) {
      throw new Error(`Missing value for ${name}`)
    }
    values.push(value)
    args.splice(index, 2)
  }
  return values
}

function parseEnvPairs(values: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of values) {
    const separator = entry.indexOf('=')
    if (separator === -1) {
      throw new Error(`Invalid --env value: ${entry}`)
    }
    const key = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1)
    if (!key) {
      throw new Error(`Invalid --env value: ${entry}`)
    }
    env[key] = value
  }
  return env
}

async function handleMcpCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...restArgs] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  const { scope, rest } = parseScope(restArgs)

  if (subcommand === 'list') {
    const servers = await loadScopedMcpServers(scope, cwd)
    if (Object.keys(servers).length === 0) {
      console.log(`No MCP servers configured in ${getMcpConfigPath(scope, cwd)}.`)
      return true
    }

    for (const [name, server] of Object.entries(servers)) {
      const endpoint =
        server.url?.trim() ||
        `${server.command ?? ''} ${server.args?.join(' ') ?? ''}`.trim()
      const protocol = server.protocol ? ` protocol=${server.protocol}` : ''
      console.log(`${name}: ${endpoint}${protocol}`.trim())
    }
    return true
  }

  if (subcommand === 'add') {
    const separatorIndex = rest.indexOf('--')
    const head = separatorIndex === -1 ? [...rest] : rest.slice(0, separatorIndex)
    const commandParts = separatorIndex === -1 ? [] : rest.slice(separatorIndex + 1)
    const name = head.shift()
    if (!name) {
      throw new Error('Missing MCP server name.')
    }

    const protocol = takeOption(head, '--protocol') as McpServerConfig['protocol']
    const url = takeOption(head, '--url')?.trim()
    const env = parseEnvPairs(takeRepeatOption(head, '--env'))
    const headers = parseEnvPairs(takeRepeatOption(head, '--header'))
    if (head.length > 0) {
      throw new Error(`Unknown arguments: ${head.join(' ')}`)
    }

    const hasUrl = Boolean(url)
    const hasCommand = commandParts.length > 0
    if (hasUrl && hasCommand) {
      throw new Error('Cannot set both --url and local command. Choose one.')
    }
    if (!hasUrl && !hasCommand) {
      throw new Error('Missing MCP command or --url.')
    }
    if (protocol === 'streamable-http' && !hasUrl) {
      throw new Error('Protocol streamable-http requires --url.')
    }

    const [command = '', ...commandArgs] = commandParts
    const existing = await loadScopedMcpServers(scope, cwd)
    existing[name] = {
      command,
      args: hasCommand ? commandArgs : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      url: hasUrl ? url : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      protocol,
    }
    await saveScopedMcpServers(scope, existing, cwd)
    console.log(`Added MCP server ${name} to ${getMcpConfigPath(scope, cwd)}`)
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const existing = await loadScopedMcpServers(scope, cwd)
    if (!(name in existing)) {
      console.log(`MCP server ${name} not found in ${getMcpConfigPath(scope, cwd)}`)
      return true
    }
    delete existing[name]
    await saveScopedMcpServers(scope, existing, cwd)
    console.log(`Removed MCP server ${name} from ${getMcpConfigPath(scope, cwd)}`)
    return true
  }

  if (subcommand === 'login') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const token = takeOption(rest, '--token')?.trim()
    if (!token) {
      throw new Error('Missing --token value.')
    }
    if (rest.length > 1) {
      throw new Error(`Unknown arguments: ${rest.slice(1).join(' ')}`)
    }
    const tokens = await readMcpTokensFile()
    tokens[name] = token
    await saveMcpTokensFile(tokens)
    console.log(`Stored MCP token for ${name} in ${MINI_CODE_MCP_TOKENS_PATH}`)
    return true
  }

  if (subcommand === 'logout') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const tokens = await readMcpTokensFile()
    if (!(name in tokens)) {
      console.log(`No token found for ${name} in ${MINI_CODE_MCP_TOKENS_PATH}`)
      return true
    }
    delete tokens[name]
    await saveMcpTokensFile(tokens)
    console.log(`Removed MCP token for ${name} from ${MINI_CODE_MCP_TOKENS_PATH}`)
    return true
  }

  printUsage()
  return true
}

async function handleSkillsCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...restArgs] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  const { scope, rest } = parseScope(restArgs)

  if (subcommand === 'list') {
    const skills = await discoverSkills(cwd)
    if (skills.length === 0) {
      console.log('No skills discovered.')
      return true
    }
    for (const skill of skills) {
      console.log(`${skill.name}: ${skill.description} (${skill.path})`)
    }
    return true
  }

  if (subcommand === 'add') {
    const sourcePath = rest[0]
    if (!sourcePath) {
      throw new Error('Missing skill source path.')
    }
    const name = takeOption(rest, '--name')
    const result = await installSkill({
      cwd,
      sourcePath,
      name,
      scope,
    })
    console.log(`Installed skill ${result.name} at ${result.targetPath}`)
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing skill name.')
    }
    const result = await removeManagedSkill({
      cwd,
      name,
      scope,
    })
    if (!result.removed) {
      console.log(`Skill ${name} not found at ${result.targetPath}`)
      return true
    }
    console.log(`Removed skill ${name} from ${result.targetPath}`)
    return true
  }

  printUsage()
  return true
}

async function handlePrCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...rest] = args
  if (subcommand === 'serve') {
    const serveArgs = [...rest]
    const host = takeOption(serveArgs, '--host') ?? '127.0.0.1'
    const portText = takeOption(serveArgs, '--port')
    const port = portText ? Number(portText) : 8787
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid --port value: ${portText ?? ''}`)
    }
    if (serveArgs.length > 0) throw new Error(`Unknown arguments: ${serveArgs.join(' ')}`)
    const runtime = await loadRuntimeConfig()
    const server = await startPrGuardServer({ runtime, host, port })
    const address = server.address()
    const displayPort = typeof address === 'object' && address ? address.port : port
    console.log(`PRGuard API listening on http://${host}:${displayPort}`)
    await new Promise<void>((resolve, reject) => {
      server.once('close', resolve)
      server.once('error', reject)
    })
    return true
  }
  if (subcommand === 'worker') {
    if (rest.length > 0) throw new Error(`Unknown arguments: ${rest.join(' ')}`)
    const runtime = await loadRuntimeConfig()
    if (!runtime.prGuardRedisUrl) {
      throw new Error('PRGuard worker requires PR_GUARD_REDIS_URL.')
    }
    const abort = new AbortController()
    const stop = (): void => abort.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      console.log('PRGuard Review Worker started.')
      await new ReviewWorker(new ReviewJobService(runtime)).run({ signal: abort.signal })
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
    return true
  }
  if (subcommand === 'eval') {
    const evalArgs = [...rest]
    const datasetPath = takeOption(evalArgs, '--dataset') ?? 'evals/tasks.jsonl'
    const predictionsPath = takeOption(evalArgs, '--predictions')
    const compareBaseline = evalArgs.includes('--compare-baseline')
    if (compareBaseline) evalArgs.splice(evalArgs.indexOf('--compare-baseline'), 1)
    const asJson = evalArgs.includes('--json')
    if (asJson) evalArgs.splice(evalArgs.indexOf('--json'), 1)
    const baseline = evalArgs.includes('--baseline')
    if (baseline) evalArgs.splice(evalArgs.indexOf('--baseline'), 1)
    if (evalArgs.length > 0) {
      throw new Error(`Unknown arguments: ${evalArgs.join(' ')}`)
    }
    if (baseline && predictionsPath) {
      throw new Error('Choose only one of --baseline or --predictions.')
    }
    if (!baseline && !predictionsPath) {
      throw new Error('Evaluation requires --baseline or --predictions <file>.')
    }
    const evaluationService = new EvaluationService()
    const report = await evaluationService.evaluate({
      datasetPath,
      predictionsPath,
      source: predictionsPath ? 'predictions' : 'baseline',
    })
    if (compareBaseline && !predictionsPath) {
      throw new Error('--compare-baseline requires --predictions <file>.')
    }
    if (compareBaseline) {
      const baseline = await evaluationService.evaluate({ datasetPath, source: 'baseline' })
      const comparison = evaluationService.compare(report, baseline)
      console.log(asJson
        ? JSON.stringify({ report, baseline, comparison }, null, 2)
        : `${evaluationService.format(report)}\n\nComparison with rule baseline:\n${JSON.stringify(comparison.delta)}\nRegressions: ${comparison.regressions.length === 0 ? 'none' : comparison.regressions.join(', ')}`)
    } else {
      console.log(asJson ? JSON.stringify(report, null, 2) : evaluationService.format(report))
    }
    return true
  }

  if (subcommand === 'trace') {
    const [traceCommand, runId] = rest
    if (traceCommand === 'list') {
      const traceService = new TraceService()
      const traces = await traceService.list()
      if (traces.length === 0) {
        console.log('No PRGuard traces found.')
        return true
      }
      for (const trace of traces) {
        console.log(`${trace.runId}  ${trace.status ?? 'unknown'}  events=${trace.eventCount}  ${trace.cwd ?? ''}`.trim())
      }
      return true
    }
    if (traceCommand === 'resume' && runId) {
      const traceArgs = rest.slice(2)
      const multiAgent = traceArgs.includes('--multi-agent')
      if (traceArgs.some(arg => arg !== '--multi-agent')) {
        throw new Error(`Unknown arguments: ${traceArgs.filter(arg => arg !== '--multi-agent').join(' ')}`)
      }
      const runtime = await loadRuntimeConfig()
      const resumed = await new ReviewService(runtime).resume(runId, multiAgent)
      console.log(`Resumed PRGuard run ${runId} as ${resumed.trace.runId}`)
      console.log(formatReviewResult(resumed.result))
      return true
    }
    if ((traceCommand === 'show' || traceCommand === 'replay') && runId) {
      const traceService = new TraceService()
      const events = await traceService.load(runId)
      console.log(traceService.replay(events))
      return true
    }
    printUsage()
    return true
  }

  if (subcommand === 'repair') {
    const repairArgs = [...rest]
    const baseRef = takeOption(repairArgs, '--base')
    const headRef = takeOption(repairArgs, '--head')
    const diffPath = takeOption(repairArgs, '--diff')
    const findingId = takeOption(repairArgs, '--finding')
    const testCommand = takeOption(repairArgs, '--test-command')
    const reviewRunId = takeOption(repairArgs, '--review-run')
    const asJson = repairArgs.includes('--json')
    if (asJson) repairArgs.splice(repairArgs.indexOf('--json'), 1)
    if (repairArgs.length > 0) {
      throw new Error(`Unknown arguments: ${repairArgs.join(' ')}`)
    }
    if (!findingId) throw new Error('Missing --finding value.')
    if (!testCommand) throw new Error('Missing --test-command value.')

    const snapshot = await loadPrDiffSnapshot({
      cwd,
      baseRef,
      headRef,
      diffPath,
      testCommand,
    })
    const runtime = await loadRuntimeConfig()
    const reviewService = new ReviewService(runtime)
    const repairService = new RepairService(runtime)
    const traceService = new TraceService()
    const trace = await traceService.create(snapshot.input)
    await trace.record('checkpoint', { phase: 'review_started' })
    let patch
    try {
      let review
      if (reviewRunId) {
        const events = await traceService.load(reviewRunId)
        const completed = [...events].reverse().find(event =>
          event.type === 'review_completed' && event.payload.result,
        )
        if (!completed) {
          throw new Error(`Review run does not contain a reusable review result: ${reviewRunId}`)
        }
        review = reviewResultSchema.parse(completed.payload.result)
        await trace.record('checkpoint', { phase: 'review_reused', sourceRunId: reviewRunId })
      } else {
        review = await reviewService.review(snapshot, { trace })
      }
      await trace.record('checkpoint', { phase: 'review_ready' })
      patch = await repairService.generate(snapshot, review, [findingId], trace)
    } catch (error) {
      await trace.record('run_failed', {
        phase: 'repair_generation',
        error: error instanceof Error ? error.message : String(error),
      })
      await trace.flush()
      throw error
    }

    if (asJson) {
      console.log(JSON.stringify(patch, null, 2))
      await trace.record('run_finished', { status: 'patch_generated' })
      await trace.flush()
      return true
    }

    console.log(formatPatch(patch))
    console.log('\nThis patch will be checked, applied only to a clean worktree, and verified with:')
    console.log(`  ${testCommand}`)
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await prompt.question('\nApply this patch? [y/N] ')
    prompt.close()
    if (!/^y(es)?$/i.test(answer.trim())) {
      await trace.record('approval', { approved: false })
      await trace.record('run_finished', { status: 'rejected' })
      await trace.flush()
      console.log('Patch rejected; no files were changed.')
      return true
    }

    await trace.record('approval', { approved: true })
    const applied = await repairService.apply(cwd, patch, testCommand, trace)
    await trace.record('run_finished', { status: applied.patch.status })
    await trace.flush()
    console.log(`\nPatch status: ${applied.patch.status}`)
    console.log(`Verification: ${applied.verification.status}`)
    if (applied.verification.output) {
      console.log(applied.verification.output)
    }
    return true
  }

  if (subcommand !== 'review') {
    printUsage()
    return true
  }

  const reviewArgs = [...rest]
  const baseRef = takeOption(reviewArgs, '--base')
  const headRef = takeOption(reviewArgs, '--head')
  const diffPath = takeOption(reviewArgs, '--diff')
  const githubRef = takeOption(reviewArgs, '--github')
  const testCommand = takeOption(reviewArgs, '--test-command')
  const asJson = reviewArgs.includes('--json')
  if (asJson) reviewArgs.splice(reviewArgs.indexOf('--json'), 1)
  const multiAgent = reviewArgs.includes('--multi-agent')
  if (multiAgent) reviewArgs.splice(reviewArgs.indexOf('--multi-agent'), 1)
  const previewOnly = reviewArgs.includes('--preview')
  if (previewOnly) reviewArgs.splice(reviewArgs.indexOf('--preview'), 1)
  if (reviewArgs.length > 0) {
    throw new Error(`Unknown arguments: ${reviewArgs.join(' ')}`)
  }

  if (githubRef && (baseRef || headRef || diffPath)) {
    throw new Error('Choose only one review source: --github, --base, or --diff.')
  }
  const snapshot = githubRef
    ? await loadGithubPrDiffSnapshot({ cwd, githubRef, testCommand })
    : await loadPrDiffSnapshot({ cwd, baseRef, headRef, diffPath, testCommand })

  if (previewOnly) {
    if (asJson) {
      console.log(JSON.stringify(snapshot, null, 2))
    } else {
      console.log(githubRef ? 'PRGuard v0.1 GitHub PR review input' : 'PRGuard v0.1 local review input')
      console.log('Preview only; model analysis was not started.\n')
      console.log(formatDiffSnapshot(snapshot))
    }
    return true
  }

  const runtime = await loadRuntimeConfig()
  const reviewService = new ReviewService(runtime)
  const traceService = new TraceService()
  const trace = await traceService.create(snapshot.input)
  let result
  try {
    result = await reviewService.review(snapshot, { multiAgent, trace })
    await trace.record('run_finished', { status: 'review_completed' })
    await trace.flush()
  } catch (error) {
    await trace.record('run_failed', {
      phase: 'review',
      error: error instanceof Error ? error.message : String(error),
    })
    await trace.flush()
    throw error
  }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatReviewResult(result))
  }
  return true
}

export async function maybeHandleManagementCommand(
  cwd: string,
  argv: string[],
): Promise<boolean> {
  const [category, ...rest] = argv
  if (!category) {
    return false
  }

  if (category === 'mcp') {
    return handleMcpCommand(cwd, rest)
  }

  if (category === 'skills') {
    return handleSkillsCommand(cwd, rest)
  }

  if (category === 'pr') {
    return handlePrCommand(cwd, rest)
  }

  if (category === 'help' || category === '--help' || category === '-h') {
    printUsage()
    return true
  }

  return false
}
