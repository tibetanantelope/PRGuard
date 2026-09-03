import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SANDBOX_CONFIG,
  buildDockerSandboxArgs,
  runSandboxedVerification,
  sanitizedVerificationEnvironment,
  validatePatchSafety,
  type VerificationProcessExecutor,
} from '../src/prguard/index.js'

test('docker verification uses a locked-down container without network access', () => {
  const args = buildDockerSandboxArgs(
    'D:\\repo',
    'npm',
    ['test'],
    { ...DEFAULT_SANDBOX_CONFIG, mode: 'docker' },
    'verify-1',
  )
  assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--name', 'verify-1'])
  assert.ok(args.includes('none'))
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('ALL'))
  assert.ok(args.includes('no-new-privileges'))
  assert.ok(args.includes('--pids-limit'))
  assert.ok(args.includes('--memory'))
  assert.ok(args.includes('--cpus'))
  assert.ok(args.includes('--user'))
  assert.equal(args.at(-2), 'npm')
  assert.equal(args.at(-1), 'test')
})

test('docker sandbox rejects option-like image references and non-numeric users', () => {
  assert.throws(
    () => buildDockerSandboxArgs('D:\\repo', 'npm', ['test'], {
      ...DEFAULT_SANDBOX_CONFIG, image: '--privileged',
    }, 'verify-1'),
    /invalid reference/,
  )
  assert.throws(
    () => buildDockerSandboxArgs('D:\\repo', 'npm', ['test'], {
      ...DEFAULT_SANDBOX_CONFIG, user: 'root',
    }, 'verify-1'),
    /numeric uid:gid/,
  )
})

test('verification environment removes credentials and runtime injection variables', () => {
  const env = sanitizedVerificationEnvironment({
    PATH: 'safe-path',
    ANTHROPIC_API_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    DATABASE_PASSWORD: 'secret',
    NODE_OPTIONS: '--require malicious.js',
  })
  assert.equal(env.PATH, 'safe-path')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.DATABASE_PASSWORD, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.CI, 'true')
})

test('docker sandbox fails closed and force-removes a timed-out container', async () => {
  const calls: Array<{ file: string; args: string[] }> = []
  const executor: VerificationProcessExecutor = async (file, args) => {
    calls.push({ file, args })
    if (args[0] === 'run') {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
    }
    return {}
  }
  const result = await runSandboxedVerification('D:\\repo', 'npm test', {
    sandbox: { mode: 'docker' },
    executor,
  })
  assert.equal(result.passed, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.isolation, 'docker-container')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]?.args.slice(0, 2), ['rm', '--force'])
  assert.equal(calls[1]?.args[2], calls[0]?.args[3])
})

test('docker unavailability is a verification failure, never a local fallback', async () => {
  const result = await runSandboxedVerification('D:\\repo', 'npm test', {
    sandbox: { mode: 'docker' },
    executor: async () => { throw Object.assign(new Error('docker not found'), { code: 'ENOENT' }) },
  })
  assert.equal(result.passed, false)
  assert.equal(result.isolation, 'docker-container')
  assert.match(result.output, /docker not found/)
})

test('verification output is bounded before persistence', async () => {
  const result = await runSandboxedVerification(process.cwd(), 'node --version', {
    sandbox: { mode: 'local', maxOutputBytes: 16 },
    executor: async () => ({ stdout: 'x'.repeat(100) }),
  })
  assert.equal(result.passed, true)
  assert.match(result.output, /truncated at 16 bytes/)
})

test('patch safety gate rejects oversized, binary, symlink, and git-metadata changes', () => {
  const normalHeader = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -0,0 +1 @@\n+x\n'
  assert.throws(() => validatePatchSafety(normalHeader, { maxBytes: 10 }), /byte safety limit/)
  assert.throws(() => validatePatchSafety(normalHeader + 'GIT binary patch\n'), /binary content/)
  assert.throws(
    () => validatePatchSafety('diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target\n'),
    /symlinks or Git submodules/,
  )
  assert.throws(
    () => validatePatchSafety('diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b\n'),
    /unsafe path/,
  )
})
