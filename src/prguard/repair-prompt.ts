import type { PrDiffSnapshot, ReviewResult } from './types.js'

export function buildPatchSystemPrompt(): string {
  return [
    'You are PRGuard, a safe code remediation agent.',
    'Generate a minimal unified Git patch for the selected evidence-backed findings.',
    'Do not modify files or claim that tests passed.',
    'Inspect relevant repository files with read-only tools when necessary.',
    'Only change files needed to address the selected findings.',
    'Preserve existing behavior outside the fix and avoid unrelated formatting changes.',
    'Return only one JSON object with this shape:',
    '{"summary":"...","unifiedDiff":"diff --git ...","files":["src/file.ts"],"findingIds":["finding-001"]}',
    'The unifiedDiff must be a valid git apply patch.',
  ].join('\n')
}

export function buildPatchUserPrompt(
  snapshot: PrDiffSnapshot,
  review: ReviewResult,
  findingIds: string[],
): string {
  const selected = review.findings.filter(finding => findingIds.includes(finding.id))
  return [
    'Generate a patch for these PRGuard findings.',
    '',
    `Repository: ${snapshot.repository.root}`,
    'Selected findings:',
    JSON.stringify(selected, null, 2),
    '',
    'Original PR diff:',
    '```diff',
    snapshot.diffText,
    '```',
    '',
    'Return only the requested JSON object. The patch must be minimal and apply cleanly with git apply --check.',
  ].join('\n')
}

