import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyAndVerifyPatch,
  formatPatch,
  parseModelPatchOutput,
  repairWithVerificationRetries,
  runVerificationCommand,
} from '../src/prguard/index.js'
import { runGitCommand } from '../src/prguard/index.js'

const patchText = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,1 +1,1 @@
-const command = input
+const command = validate(input)
`

describe('PRGuard repair', () => {
  it('feeds failed verification back into a bounded repair retry', async () => {
    const feedback: string[] = []
    let generated = 0
    const result = await repairWithVerificationRetries(
      async context => {
        generated += 1
        if (context.previous) feedback.push(context.previous.verificationOutput)
        return makePatch()
      },
      async () => ({
        patch: makePatch(),
        verification: {
          status: generated === 1 ? 'failed' : 'passed',
          command: 'npm test',
          output: generated === 1 ? 'assertion failed' : 'ok',
          isolation: 'local-process',
        },
      }),
    )

    assert.equal(result.attempts.length, 2)
    assert.equal(result.final.verification.status, 'passed')
    assert.deepEqual(feedback, ['assertion failed'])
  })

  it('parses a model patch and keeps it pending', () => {
    const patch = parseModelPatchOutput(`
      {
        "summary": "Validate command input",
        "unifiedDiff": ${JSON.stringify(patchText)},
        "files": ["src/auth.ts"],
        "findingIds": ["finding-001"]
      }
    `, ['finding-001'])

    assert.equal(patch.status, 'pending')
    assert.equal(patch.findingIds[0], 'finding-001')
    assert.match(formatPatch(patch), /Validate command input/)
  })

  it('rejects a patch that omits a selected finding', () => {
    assert.throws(
      () => parseModelPatchOutput(JSON.stringify({
        summary: 'Incomplete',
        unifiedDiff: patchText,
        files: ['src/auth.ts'],
        findingIds: [],
      }), ['finding-001']),
      /Invalid PRGuard patch output|does not cover every selected finding/,
    )
  })

  it('runs npm.cmd verification on Windows without shell=true', async () => {
    if (process.platform !== 'win32') return
    const result = await runVerificationCommand(process.cwd(), 'npm.cmd --version')
    assert.equal(result.passed, true)
    assert.match(result.output, /\d+\.\d+\.\d+/)
  })

  it('rejects shell metacharacters in verification commands', async () => {
    await assert.rejects(
      () => runVerificationCommand(process.cwd(), 'node verify.mjs && echo unsafe'),
      /disallowed shell characters/,
    )
  })

  it('times out verification in the isolated worktree and leaves the source unchanged', async () => {
    const cwd = await createRepairRepo(true, true)
    try {
      const direct = await runVerificationCommand(cwd, 'node slow.mjs', { timeoutMs: 20 })
      assert.equal(direct.passed, false)
      const result = await applyAndVerifyPatch(cwd, makePatch(), 'node slow.mjs', { verificationTimeoutMs: 20 })
      assert.equal(result.patch.status, 'rolled_back')
      assert.equal(normalizeNewlines(await readFile(path.join(cwd, 'src', 'app.js'), 'utf8')), "export const value = 'bad'\n")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('applies a patch and keeps it when verification passes', async () => {
    const cwd = await createRepairRepo()
    try {
      const result = await applyAndVerifyPatch(cwd, makePatch(), 'node verify.mjs')
      assert.equal(result.patch.status, 'applied')
      assert.equal(result.verification.status, 'passed')
      assert.equal(normalizeNewlines(await readFile(path.join(cwd, 'src', 'app.js'), 'utf8')), "export const value = 'fixed'\n")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rolls a patch back when verification fails', async () => {
    const cwd = await createRepairRepo(false)
    try {
      const result = await applyAndVerifyPatch(cwd, makePatch(), 'node verify.mjs')
      assert.equal(result.patch.status, 'rolled_back')
      assert.equal(result.verification.status, 'failed')
      assert.equal(normalizeNewlines(await readFile(path.join(cwd, 'src', 'app.js'), 'utf8')), "export const value = 'bad'\n")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('applies a patch only after the configured docker sandbox succeeds', async () => {
    const cwd = await createRepairRepo()
    try {
      const calls: Array<{ file: string; args: string[] }> = []
      const result = await applyAndVerifyPatch(cwd, makePatch(), 'node verify.mjs', {
        sandbox: { mode: 'docker' },
        verificationExecutor: async (file, args) => {
          calls.push({ file, args })
          return { stdout: 'sandbox tests passed' }
        },
      })
      assert.equal(result.patch.status, 'applied')
      assert.equal(result.verification.isolation, 'docker-container')
      assert.equal(calls[0]?.file, 'docker')
      assert.equal(calls[0]?.args[0], 'run')
      assert.equal(normalizeNewlines(await readFile(path.join(cwd, 'src', 'app.js'), 'utf8')), "export const value = 'fixed'\n")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rolls back instead of falling back locally when docker cannot start', async () => {
    const cwd = await createRepairRepo()
    try {
      const result = await applyAndVerifyPatch(cwd, makePatch(), 'node verify.mjs', {
        sandbox: { mode: 'docker' },
        verificationExecutor: async () => { throw Object.assign(new Error('docker unavailable'), { code: 'ENOENT' }) },
      })
      assert.equal(result.patch.status, 'rolled_back')
      assert.equal(result.verification.isolation, 'docker-container')
      assert.match(result.verification.output, /docker unavailable/)
      assert.equal(normalizeNewlines(await readFile(path.join(cwd, 'src', 'app.js'), 'utf8')), "export const value = 'bad'\n")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('refuses to apply a patch when tracked files are already dirty', async () => {
    const cwd = await createRepairRepo()
    try {
      await writeFile(path.join(cwd, 'src', 'app.js'), "export const value = 'manual-change'\n")
      await assert.rejects(
        () => applyAndVerifyPatch(cwd, makePatch(), 'node verify.mjs'),
        /worktree has tracked local changes/,
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

async function createRepairRepo(verificationPasses = true, includeSlow = false): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'prguard-repair-'))
  await writeFile(path.join(cwd, 'verify.mjs'), verificationPasses
    ? "import { readFile } from 'node:fs/promises'; if ((await readFile('src/app.js', 'utf8')).replaceAll('\\r\\n', '\\n') !== \"export const value = 'fixed'\\n\") process.exit(1)\n"
    : 'process.exit(1)\n')
  await mkdir(path.join(cwd, 'src'))
  await writeFile(path.join(cwd, 'src', 'app.js'), "export const value = 'bad'\n")
  if (includeSlow) {
    await writeFile(path.join(cwd, 'slow.mjs'), 'setTimeout(() => process.exit(0), 1000)\n')
  }
  for (const args of [
    ['init'],
    ['add', '.'],
    ['-c', 'user.name=PRGuard Test', '-c', 'user.email=prguard@example.test', 'commit', '-m', 'baseline'],
  ]) {
    await runGitCommand(cwd, args)
  }
  return cwd
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function makePatch() {
  return {
    status: 'pending' as const,
    summary: 'Fix value',
    unifiedDiff: `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-export const value = 'bad'
+export const value = 'fixed'
`,
    files: ['src/app.js'],
    findingIds: ['finding-001'],
  }
}
