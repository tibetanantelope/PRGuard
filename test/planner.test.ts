import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkingMemory } from '../src/runtime/index.js'
import { HeuristicPlanner, validatePlan, InvalidPlanError } from '../src/runtime/planner.js'

test('planner decomposes implementation tasks into executable stages', () => {
  const planner = new HeuristicPlanner()
  const memory = createWorkingMemory('Implement a safe retry policy')
  const plan = planner.plan({ goal: memory.goal, workingMemory: memory })
  assert.ok(plan.length >= 4)
  assert.equal(plan.every(step => step.status === 'pending'), true)
  assert.match(plan.map(step => step.description).join(' '), /验证/)
})

test('planner replans failed work before remaining steps', () => {
  const planner = new HeuristicPlanner()
  const memory = {
    ...createWorkingMemory('Fix the tool'),
    plan: [
      {
        id: 'done', description: 'finished', status: 'completed' as const, attempts: 1,
        capability: 'read' as const, dependsOn: [], acceptanceCriteria: 'inspected', idempotencyKey: 'done',
      },
      {
        id: 'failed', description: 'modify', status: 'failed' as const, attempts: 1,
        capability: 'write' as const, dependsOn: ['done'], acceptanceCriteria: 'modified', idempotencyKey: 'failed',
      },
      {
        id: 'next', description: 'continue', status: 'pending' as const, attempts: 0,
        capability: 'verify' as const, dependsOn: ['failed'], acceptanceCriteria: 'verified', idempotencyKey: 'next',
      },
    ],
  }
  const plan = planner.replan({ goal: memory.goal, workingMemory: memory, error: 'permission denied' })
  assert.match(plan[0]?.description ?? '', /permission denied/)
  assert.equal(plan[1]?.id, 'failed')
  assert.deepEqual(plan[1]?.dependsOn, [plan[0]?.id])
  assert.deepEqual(plan[2]?.dependsOn, ['failed'])
  assert.equal(plan.some(step => step.dependsOn.includes('done')), false)
})

test('planner rejects duplicate, missing, and cyclic dependencies', () => {
  assert.throws(() => validatePlan([
    { id: 'a', description: 'a', status: 'pending', attempts: 0, capability: 'read', dependsOn: ['missing'], acceptanceCriteria: 'a', idempotencyKey: 'a' },
  ]), InvalidPlanError)
  assert.throws(() => validatePlan([
    { id: 'a', description: 'a', status: 'pending', attempts: 0, capability: 'read', dependsOn: ['b'], acceptanceCriteria: 'a', idempotencyKey: 'a' },
    { id: 'b', description: 'b', status: 'pending', attempts: 0, capability: 'read', dependsOn: ['a'], acceptanceCriteria: 'b', idempotencyKey: 'b' },
  ]), /cycle/)
})

test('planner stops retrying the same failed step after three attempts', () => {
  const planner = new HeuristicPlanner()
  const memory = {
    ...createWorkingMemory('Fix the tool'),
    activeStep: 'failed',
    plan: [{
      id: 'failed', description: 'modify', status: 'failed' as const, attempts: 2,
      capability: 'write' as const, dependsOn: [], acceptanceCriteria: 'modified', idempotencyKey: 'failed',
    }],
  }
  const plan = planner.replan({ goal: memory.goal, workingMemory: memory, error: 'still failing' })
  assert.equal(plan.find(step => step.id === 'failed')?.status, 'skipped')
  validatePlan(plan)
})
