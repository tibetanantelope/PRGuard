import { z } from 'zod'

export const PRGUARD_SCHEMA_VERSION = '0.1'

export const riskCategories = [
  'security',
  'reliability',
  'code_quality',
] as const

export const severities = ['low', 'medium', 'high', 'critical'] as const

export const evidenceSources = [
  'diff',
  'repository',
  'code',
  'dependency',
  'configuration',
  'test',
] as const

export const findingStatuses = [
  'open',
  'accepted',
  'fixed',
  'dismissed',
] as const

export const verificationStatuses = [
  'pending',
  'running',
  'passed',
  'failed',
  'skipped',
] as const

export type RiskCategory = (typeof riskCategories)[number]
export type Severity = (typeof severities)[number]
export type EvidenceSource = (typeof evidenceSources)[number]
export type FindingStatus = (typeof findingStatuses)[number]
export type VerificationStatus = (typeof verificationStatuses)[number]

export const evidenceSchema = z.object({
  source: z.enum(evidenceSources),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  content: z.string().min(1),
  explanation: z.string().min(1),
})

export type Evidence = z.infer<typeof evidenceSchema>

export const verificationSchema = z.object({
  status: z.enum(verificationStatuses),
  commands: z.array(z.string().min(1)),
  passedCommands: z.array(z.string().min(1)).default([]),
  failedCommands: z.array(z.string().min(1)).default([]),
  output: z.string().optional(),
  error: z.string().optional(),
})

export type Verification = z.infer<typeof verificationSchema>

export const findingSchema = z.object({
  id: z.string().min(1),
  category: z.enum(riskCategories),
  severity: z.enum(severities),
  confidence: z.number().min(0).max(1),
  status: z.enum(findingStatuses).default('open'),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  title: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
  reason: z.string().min(1),
  suggestedFix: z.string().min(1),
  verification: verificationSchema,
})

export type Finding = z.infer<typeof findingSchema>

export const patchSchema = z.object({
  status: z.enum(['pending', 'approved', 'applied', 'rejected', 'rolled_back']),
  summary: z.string().min(1),
  unifiedDiff: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  findingIds: z.array(z.string().min(1)).min(1),
})

export type Patch = z.infer<typeof patchSchema>

export const reviewInputSchema = z.object({
  cwd: z.string().min(1),
  baseRef: z.string().min(1).optional(),
  headRef: z.string().min(1).optional(),
  diffPath: z.string().min(1).optional(),
  githubRef: z.string().min(1).optional(),
  githubSha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  diffText: z.string().min(1).optional(),
  testCommand: z.string().min(1).optional(),
})
  .refine(
    input => Boolean(input.diffText || input.diffPath || input.baseRef || input.githubRef),
    'Review input requires diffText, diffPath, baseRef, or githubRef',
  )

export type ReviewInput = z.infer<typeof reviewInputSchema>

export const diffStatuses = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'unknown',
] as const

export type DiffStatus = (typeof diffStatuses)[number]

export type DiffHunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  header: string
}

export type ChangedFile = {
  path: string
  oldPath?: string
  status: DiffStatus
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

export type RepositoryContext = {
  root: string
  branch?: string
  projectFiles: string[]
  instructionFiles: string[]
}

export type PrDiffSnapshot = {
  input: ReviewInput
  diffText: string
  changedFiles: ChangedFile[]
  repository: RepositoryContext
}

export const reviewSummarySchema = z.object({
  totalFindings: z.number().int().nonnegative(),
  bySeverity: z.object({
    low: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
  }),
  byCategory: z.object({
    security: z.number().int().nonnegative(),
    reliability: z.number().int().nonnegative(),
    code_quality: z.number().int().nonnegative(),
  }),
})

export type ReviewSummary = z.infer<typeof reviewSummarySchema>

export const reviewResultSchema = z.object({
  schemaVersion: z.literal(PRGUARD_SCHEMA_VERSION),
  reviewId: z.string().min(1),
  createdAt: z.string().datetime(),
  input: reviewInputSchema,
  findings: z.array(findingSchema),
  summary: reviewSummarySchema,
  evidenceVerification: z.object({
    checkedFindingCount: z.number().int().nonnegative(),
    acceptedFindingCount: z.number().int().nonnegative(),
    rejectedFindingCount: z.number().int().nonnegative(),
    rejectedFindingIds: z.array(z.string().min(1)),
  }).optional(),
  patch: patchSchema.optional(),
})

export type ReviewResult = z.infer<typeof reviewResultSchema>
