import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import type { ExecFileOptions } from 'node:child_process'

export type VerificationSandboxMode = 'local' | 'docker'

export type VerificationSandboxConfig = {
  mode: VerificationSandboxMode
  image: string
  memoryMb: number
  cpus: number
  pidsLimit: number
  maxOutputBytes: number
  user: string
}

export type VerificationExecution = {
  passed: boolean
  output: string
  timedOut?: boolean
  isolation: 'local-process' | 'docker-container'
}

export type SandboxReadiness = {
  ready: boolean
  mode: VerificationSandboxMode
  detail?: string
}

type ProcessResult = { stdout?: string | Buffer; stderr?: string | Buffer }
export type VerificationProcessExecutor = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<ProcessResult>

export const DEFAULT_SANDBOX_CONFIG: VerificationSandboxConfig = {
  mode: 'local',
  image: 'node:22-alpine',
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 128,
  maxOutputBytes: 1024 * 1024,
  user: '65532:65532',
}

const allowedCommands = new Set([
  'npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd',
  'node', 'node.exe', 'pytest', 'cargo', 'go',
])

export function parseVerificationCommand(commandLine: string): [string, string[]] {
  if (/[\r\n;&|<>`$]/.test(commandLine)) {
    throw new Error('Verification command contains disallowed shell characters.')
  }
  const parts = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(part =>
    part.replace(/^(["'])(.*)\1$/, '$2'),
  ) ?? []
  const [command, ...args] = parts
  if (!command) throw new Error('Verification command cannot be empty.')
  if (!allowedCommands.has(command.toLowerCase())) {
    throw new Error(`Verification command is not allowed: ${command}`)
  }
  return [command, args]
}

export function sanitizedVerificationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|COOKIE|CREDENTIAL|PRIVATE[_-]?KEY)/i
  const dangerousRuntime = /^(?:NODE_OPTIONS|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|LD_PRELOAD|DYLD_INSERT_LIBRARIES|GIT_CONFIG(?:_COUNT|_KEY_\d+|_VALUE_\d+)?)$/i
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.test(key) && !dangerousRuntime.test(key)))
  return { ...env, CI: 'true', NO_COLOR: '1' }
}

export function buildDockerSandboxArgs(
  cwd: string,
  command: string,
  args: string[],
  config: VerificationSandboxConfig,
  containerName: string,
): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(config.image)) {
    throw new Error('Docker sandbox image has an invalid reference.')
  }
  if (!/^\d+:\d+$/.test(config.user)) {
    throw new Error('Docker sandbox user must be a numeric uid:gid pair.')
  }
  if (cwd.includes(',')) {
    throw new Error('Docker sandbox workspace path cannot contain a comma.')
  }
  for (const [name, value] of Object.entries({
    memoryMb: config.memoryMb,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    maxOutputBytes: config.maxOutputBytes,
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Docker sandbox ${name} must be positive.`)
  }
  return [
    'run', '--rm', '--name', containerName,
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(config.pidsLimit),
    '--memory', `${config.memoryMb}m`,
    '--cpus', String(config.cpus),
    '--user', config.user,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--workdir', '/workspace',
    '--mount', `type=bind,src=${cwd},dst=/workspace,rw`,
    '--env', 'CI=true',
    '--env', 'NO_COLOR=1',
    config.image,
    command,
    ...args,
  ]
}

function defaultExecutor(file: string, args: string[], options: ExecFileOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr })
        reject(error)
      } else resolve({ stdout, stderr })
    })
  })
}

export async function checkVerificationSandbox(
  mode: VerificationSandboxMode,
  executor: VerificationProcessExecutor = defaultExecutor,
): Promise<SandboxReadiness> {
  if (mode === 'local') return { ready: true, mode, detail: 'trusted-development-only' }
  try {
    await executor('docker', ['version', '--format', '{{.Server.Version}}'], {
      windowsHide: true,
      timeout: 5_000,
      env: sanitizedVerificationEnvironment(),
    })
    return { ready: true, mode }
  } catch {
    return {
      ready: false,
      mode,
      detail: 'docker-daemon-unavailable',
    }
  }
}

function boundedOutput(parts: unknown[], maxBytes: number): string {
  const value = parts.filter(Boolean).map(String).join('\n').trim()
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  return `${bytes.subarray(0, maxBytes).toString('utf8')}\n...[verification output truncated at ${maxBytes} bytes]`
}

export async function runSandboxedVerification(
  cwd: string,
  commandLine: string,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    sandbox?: Partial<VerificationSandboxConfig>
    executor?: VerificationProcessExecutor
  } = {},
): Promise<VerificationExecution> {
  const [command, args] = parseVerificationCommand(commandLine)
  const config = { ...DEFAULT_SANDBOX_CONFIG, ...options.sandbox }
  const executor = options.executor ?? defaultExecutor
  const containerName = `prguard-verify-${crypto.randomUUID()}`
  const isDocker = config.mode === 'docker'
  const isWindowsScript = !isDocker && process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
  const file = isDocker ? 'docker' : isWindowsScript ? (process.env.ComSpec ?? 'cmd.exe') : command
  const processArgs = isDocker
    ? buildDockerSandboxArgs(cwd, command.replace(/\.(?:exe|cmd)$/i, ''), args, config, containerName)
    : isWindowsScript
      ? ['/d', '/s', '/c', [command, ...args].join(' ')]
      : args
  try {
    const result = await executor(file, processArgs, {
      cwd: isDocker ? undefined : cwd,
      env: sanitizedVerificationEnvironment(),
      maxBuffer: config.maxOutputBytes,
      windowsHide: true,
      timeout: options.timeoutMs ?? 120_000,
      killSignal: 'SIGTERM',
      signal: options.signal,
    })
    return {
      passed: true,
      output: boundedOutput([result.stdout, result.stderr], config.maxOutputBytes),
      isolation: isDocker ? 'docker-container' : 'local-process',
    }
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string; code?: string }
    const timedOut = detail.killed === true || detail.signal === 'SIGTERM' || detail.code === 'ABORT_ERR'
    if (isDocker && timedOut) {
      await executor('docker', ['rm', '--force', containerName], {
        windowsHide: true,
        timeout: 10_000,
        env: sanitizedVerificationEnvironment(),
      }).catch(() => undefined)
    }
    return {
      passed: false,
      output: boundedOutput([detail.stdout, detail.stderr, detail.message], config.maxOutputBytes),
      timedOut,
      isolation: isDocker ? 'docker-container' : 'local-process',
    }
  }
}
