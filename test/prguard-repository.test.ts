import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDiffSnapshot,
  loadPrDiffSnapshot,
  parseUnifiedDiff,
} from '../src/prguard/repository.js'

const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
 export function login(input: string) {
-  return authenticate(input)
+  const command = \`git show \${input}\`
+  return execute(command)
 }
`

describe('PRGuard repository input', () => {
  it('parses changed files, hunks, and line counts from a unified diff', () => {
    const files = parseUnifiedDiff(sampleDiff)

    assert.equal(files.length, 1)
    assert.deepEqual(files[0], {
      path: 'src/auth.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      hunks: [{
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 5,
        header: '@@ -1,3 +1,5 @@',
      }],
    })
  })

  it('parses a PowerShell UTF-8 diff with a leading BOM', () => {
    const files = parseUnifiedDiff('\uFEFFdiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n+new documentation\n')
    assert.equal(files.length, 1)
    assert.equal(files[0]?.path, 'README.md')
    assert.equal(files[0]?.additions, 1)
  })

  it('loads a diff file and discovers repository context', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'minicode-prguard-'))
    const localPath = path.join(process.cwd(), '.tmp-prguard-change.diff')
    try {
      await writeFile(path.join(tempDir, 'change.diff'), sampleDiff, 'utf8')

      await writeFile(localPath, sampleDiff, 'utf8')
      const snapshot = await loadPrDiffSnapshot({
        cwd: process.cwd(),
        diffPath: '.tmp-prguard-change.diff',
      })

      assert.equal(snapshot.diffText, sampleDiff)
      assert.equal(snapshot.changedFiles[0]?.path, 'src/auth.ts')
      assert.equal(snapshot.repository.root.length > 0, true)
      assert.equal(snapshot.repository.projectFiles.includes('package.json'), true)
      assert.match(formatDiffSnapshot(snapshot), /changed files: 1/)
    } finally {
      await rm(localPath, { force: true })
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects diff files outside the workspace', async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'minicode-prguard-outside-'))
    try {
      const outsidePath = path.join(outsideDir, 'change.diff')
      await writeFile(outsidePath, sampleDiff, 'utf8')
      await assert.rejects(
        loadPrDiffSnapshot({
          cwd: process.cwd(),
          diffPath: outsidePath,
        }),
        /escapes workspace/,
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
