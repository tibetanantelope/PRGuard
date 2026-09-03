import type { TaskStep, TaskStepCapability, WorkingMemory } from './types.js'
import { createId } from './ids.js'

export type PlannerInput = {
  goal: string
  workingMemory: WorkingMemory
  error?: string
}

export type AgentPlanner = {
  plan(input: PlannerInput): Promise<TaskStep[]> | TaskStep[]
  replan(input: PlannerInput): Promise<TaskStep[]> | TaskStep[]
}

function step(description: string, capability: TaskStepCapability, acceptanceCriteria: string, dependsOn: string[] = []): TaskStep {
  const id = createId('step')
  return { id, description, capability, acceptanceCriteria, dependsOn, status: 'pending', attempts: 0, idempotencyKey: id }
}

export class HeuristicPlanner implements AgentPlanner {
  plan(input: PlannerInput): TaskStep[] {
    const goal = input.goal.toLowerCase()
    const understand = step('理解任务目标、约束和验收标准', 'reasoning', '目标、范围和验收条件已明确')
    const inspect = step('检查相关代码、配置和已有实现', 'read', '已获得足以支持方案的代码证据', [understand.id])
    const steps = [understand, inspect]
    if (/(fix|修复|implement|实现|change|修改|build|构建)/i.test(goal)) {
      const modify = step('制定方案并执行必要的代码变更', 'write', '请求范围内的代码变更已落地', [inspect.id])
      const verify = step('运行针对性验证并处理发现的问题', 'verify', '相关检查和测试通过或失败原因已记录', [modify.id])
      steps.push(modify, verify)
    } else {
      steps.push(step('基于检查结果形成结论和可执行建议', 'reasoning', '结论均有检查证据支持', [inspect.id]))
    }
    steps.push(step('汇总结果、风险和未完成事项', 'report', '最终答复说明结果、验证和剩余风险', [steps.at(-1)!.id]))
    return steps
  }

  replan(input: PlannerInput): TaskStep[] {
    const satisfied = new Set(
      input.workingMemory.plan
        .filter(item => item.status === 'completed' || item.status === 'skipped')
        .map(item => item.id),
    )
    const remaining = input.workingMemory.plan
      .filter(item => item.status !== 'completed' && item.status !== 'skipped')
      .map(item => ({
        ...item,
        status: 'pending' as const,
        error: undefined,
        resultRef: undefined,
        dependsOn: item.dependsOn.filter(dependency => !satisfied.has(dependency)),
      }))
    const recovery = step(`处理上一步失败并调整方案：${input.error?.slice(0, 240) ?? '未知错误'}`, 'recovery', '失败原因已处理或形成可执行替代方案')
    return [
      recovery,
      ...remaining.map(item => item.dependsOn.length === 0
        ? { ...item, dependsOn: [recovery.id] }
        : item),
    ]
  }
}
