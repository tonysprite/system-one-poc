/**
 * approval-logger —— 审批请求回流的「打标」捕获器。
 *
 * 挂在 DSH 真实事件上，把每一次审批（approval/request）连同**最终被作出的决定
 * outcome** 追加写进 append-only 的 JSONL 历史文件：
 *   - tools/pre-execute  : 按 callId 暂存本次工具调用(含 arguments)
 *   - approval/request   : await next() 拿到真人/策略决定的 outcome，与暂存的
 *                          调用信息合并成一条记录落盘
 *
 * 生产环境里这条 JSONL 会由真实用户对 `approval/request` 的决定自动填充——
 * 这就是「从审批历史回流打标」：outcome 就是 ground-truth 标签。
 * 本 POC 中由 capture-approvals.ts 的模拟评审员驱动同一管线，产出历史文件后，
 * 由 score_eval.py --history 消费来重新定操作点。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

export const name = 'approval-logger'

export interface Config {
  /** append-only 历史文件路径（JSONL）。 */
  outputPath?: string
}

export interface ApprovalHistoryRecord {
  ts: string
  tool: string
  arguments: unknown
  reason?: string
  outcome: ApprovalOutcome
  source: 'human'
}

const DEFAULT_OUTPUT = 'tmp/system-one-poc/calibration/approval-history.jsonl'

export function apply(ctx: Context, config: Config = {}): void {
  const output = config.outputPath ?? DEFAULT_OUTPUT
  mkdirSync(dirname(output), { recursive: true })

  // callId -> 本次工具调用（含 arguments），供 approval/request 合并
  const pending = new Map<string, ToolExecution>()

  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    pending.set(String(exec.callId), exec)
    return next()
  })

  // 包一层 next()：把 outcome 也记下来（waterfall：next() 才走到评审员/真人）
  ctx.on('approval/request', async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
    const outcome = await next()
    const exec = req.callId ? pending.get(String(req.callId)) : undefined
    const record: ApprovalHistoryRecord = {
      ts: new Date().toISOString(),
      tool: req.toolName,
      arguments: exec?.arguments,
      reason: req.reason,
      outcome,
      source: 'human',
    }
    appendFileSync(output, JSON.stringify(record) + '\n')
    return outcome
  })
}
