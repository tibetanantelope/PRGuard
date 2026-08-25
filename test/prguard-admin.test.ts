import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderPrGuardAdmin } from '../src/prguard/admin.js'

describe('PRGuard admin console', () => {
  it('renders a self-contained dashboard without embedded credentials', () => {
    const html = renderPrGuardAdmin()
    assert.match(html, /PRGuard Admin Console/)
    assert.match(html, /api\/v1\/review-jobs/)
    assert.match(html, /Prometheus Metrics/)
    assert.doesNotMatch(html, /Bearer [A-Za-z0-9]{20,}/)
  })
})
