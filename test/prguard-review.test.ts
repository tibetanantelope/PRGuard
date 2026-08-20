import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPrReviewSystemPrompt,
  buildPrReviewUserPrompt,
  parseModelReviewOutput,
} from '../src/prguard/index.js'
import type { PrDiffSnapshot } from '../src/prguard/types.js'

const snapshot: PrDiffSnapshot = {
  input: {
    cwd: 'D:/workspace/demo',
    diffText: 'diff --git a/src/auth.ts b/src/auth.ts',
  },
  diffText: 'diff --git a/src/auth.ts b/src/auth.ts\n+const command = input',
  changedFiles: [{
    path: 'src/auth.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    hunks: [],
  }],
  repository: {
    root: 'D:/workspace/demo',
    branch: 'feature/auth',
    projectFiles: ['package.json'],
    instructionFiles: [],
  },
}

describe('PRGuard review output', () => {
  it('builds a review prompt with a strict JSON contract', () => {
    assert.match(buildPrReviewSystemPrompt(), /Return only one JSON object/)
    assert.match(buildPrReviewUserPrompt(snapshot), /src\/auth\.ts/)
    assert.match(buildPrReviewUserPrompt(snapshot), /Unified diff:/)
  })

  it('parses fenced model JSON and builds a complete ReviewResult', () => {
    const result = parseModelReviewOutput(`Here is the result:\n\`\`\`json
{
  "findings": [{
    "id": "finding-001",
    "category": "security",
    "severity": "high",
    "confidence": 0.93,
    "file": "src/auth.ts",
    "lineStart": 2,
    "lineEnd": 2,
    "title": "Unvalidated command input",
    "evidence": [{
      "source": "diff",
      "file": "src/auth.ts",
      "lineStart": 2,
      "lineEnd": 2,
      "content": "const command = input",
      "explanation": "User-controlled input reaches a command boundary."
    }],
    "reason": "The changed code passes input into command execution.",
    "suggestedFix": "Validate the input and use an argument-based API."
  }]
}
\`\`\``, snapshot)

    assert.equal(result.schemaVersion, '0.1')
    assert.equal(result.summary.totalFindings, 1)
    assert.equal(result.findings[0]?.verification.status, 'pending')
    assert.equal(result.findings[0]?.status, 'open')
    assert.equal(result.findings[0]?.file, 'src/auth.ts')
  })

  it('rejects model output without evidence-backed findings', () => {
    assert.throws(
      () => parseModelReviewOutput('{"findings":[{"id":"bad"}]}', snapshot),
      /Invalid PRGuard review output/,
    )
  })

  it('normalizes a single evidence object returned by a model', () => {
    const result = parseModelReviewOutput(JSON.stringify({
      findings: [{
        id: 'finding-single-evidence',
        category: 'security',
        severity: 'high',
        confidence: 0.8,
        file: 'src/auth.ts',
        lineStart: 2,
        lineEnd: 2,
        title: 'Unvalidated command input',
        evidence: {
          source: 'user_input',
          file: 'src/auth.ts',
          lineStart: 2,
          lineEnd: 2,
          content: 'const command = input',
          explanation: 'User-controlled input reaches a command boundary.',
        },
        reason: 'The changed code passes input into command execution.',
        suggestedFix: 'Validate the input and use an argument-based API.',
      }],
    }), snapshot)

    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0]?.evidence.length, 1)
  })
})
