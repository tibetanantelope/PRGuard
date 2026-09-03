import { timingSafeEqual } from 'node:crypto'
import { projectMemoryId } from '../memory/manager.js'

export type PrGuardRole = 'viewer' | 'reviewer' | 'approver' | 'operator' | 'publisher' | 'admin'
export type PrGuardAction =
  | 'review:read' | 'review:create'
  | 'repair:generate' | 'repair:approve' | 'repair:apply'
  | 'review:publish'
  | 'memory:read' | 'memory:write' | 'memory:feedback' | 'memory:archive'
  | 'trace:read' | 'dead-letter:read' | 'dead-letter:redrive' | 'admin:read'

export type PrGuardPrincipal = {
  subject: string
  roles: PrGuardRole[]
  projectIds: string[]
}

export type PrGuardCredential = PrGuardPrincipal & { token: string }

const rolePermissions: Record<PrGuardRole, ReadonlySet<PrGuardAction>> = {
  viewer: new Set(['review:read']),
  reviewer: new Set(['review:read', 'review:create', 'memory:read', 'memory:write']),
  approver: new Set(['review:read', 'repair:generate', 'repair:approve', 'memory:read', 'memory:write', 'memory:feedback']),
  operator: new Set(['review:read', 'repair:generate', 'repair:apply', 'memory:read', 'memory:write', 'dead-letter:read', 'dead-letter:redrive', 'trace:read']),
  publisher: new Set(['review:read', 'review:publish']),
  admin: new Set(),
}

export function projectAuthorizationId(cwd: string): string {
  return projectMemoryId(cwd)
}

export class PrGuardAuthorizer {
  constructor(private readonly credentials: PrGuardCredential[]) {}

  static fromEnvironment(legacyAdminToken?: string, serialized = process.env.PR_GUARD_RBAC_JSON): PrGuardAuthorizer {
    const credentials: PrGuardCredential[] = []
    if (legacyAdminToken) credentials.push({ subject: 'legacy-api-key', token: legacyAdminToken, roles: ['admin'], projectIds: ['*'] })
    if (serialized?.trim()) {
      const parsed = JSON.parse(serialized) as unknown
      if (!Array.isArray(parsed)) throw new Error('PR_GUARD_RBAC_JSON must be an array.')
      for (const value of parsed) credentials.push(parseCredential(value))
    }
    return new PrGuardAuthorizer(credentials)
  }

  get enabled(): boolean { return this.credentials.length > 0 }

  authenticate(token: string): PrGuardPrincipal | null {
    const credential = this.credentials.find(item => secureEqual(item.token, token))
    return credential ? { subject: credential.subject, roles: [...credential.roles], projectIds: [...credential.projectIds] } : null
  }

  authorize(principal: PrGuardPrincipal, action: PrGuardAction, projectId?: string): boolean {
    if (projectId && !principal.projectIds.includes('*') && !principal.projectIds.includes(projectId)) return false
    return principal.roles.includes('admin') || principal.roles.some(role => rolePermissions[role].has(action))
  }
}

export const systemPrincipal: PrGuardPrincipal = { subject: 'prguard-system', roles: ['admin'], projectIds: ['*'] }

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseCredential(value: unknown): PrGuardCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PRGuard RBAC credential.')
  const record = value as Record<string, unknown>
  const subject = String(record.subject ?? '').trim()
  const token = String(record.token ?? '').trim()
  const roles = Array.isArray(record.roles) ? record.roles.map(String) as PrGuardRole[] : []
  const projectIds = Array.isArray(record.projectIds) ? record.projectIds.map(String) : []
  const validRoles = new Set<PrGuardRole>(['viewer', 'reviewer', 'approver', 'operator', 'publisher', 'admin'])
  if (!subject || !token || roles.length === 0 || roles.some(role => !validRoles.has(role)) || projectIds.length === 0) {
    throw new Error('Each PRGuard RBAC credential requires subject, token, valid roles, and projectIds.')
  }
  return { subject, token, roles, projectIds }
}
