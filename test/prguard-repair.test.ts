import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatPatch,
  parseModelPatchOutput,
} from '../src/prguard/index.js'

const patchText = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,1 +1,1 @@
-const command = input
+const command = validate(input)
`

describe('PRGuard repair', () => {
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
})

