/**
 * system-one-guard —— 用 System-One 决策（laya sidecar）为 DSH 的
 * `tools/pre-execute` 提供自动化的 allow/ask/deny 三态审批。
 *
 * 这是一个最小 POC 插件，忠实遵循 DSH 插件约定：导出 `apply(ctx, config)`，
 * 挂在 cordis Context 上，通过 `ctx.on('tools/pre-execute', ...)` 拦截每次
 * 工具调用，把「是否放行」这个决策外包给 typecheck 的 laya 模型。
 *
 * 语义:
 *   - sidecar 判定 allow  -> next() 放行
 *   - sidecar 判定 ask    -> 返回 { kind: 'ask' } 走 DSH 审批通道（人确认/拒绝）
 *   - sidecar 判定 deny   -> 返回 { kind: 'deny' } 直接拦截，绝不执行
 *   - sidecar 不可达      -> fail-open（记录后放行），避免系统一连挂就全瘫
 *
 * 注意校准：#先用真实样本校准阈值，别拿这套 off-the-shelf 判定当生产官能。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'system-one-guard'

export interface Config {
  /** laya sidecar 基址，例如 http://127.0.0.1:8787 */
  sidecarBaseUrl?: string
}

/** 兜底基址与 fail-open 的超时。 */
const DEFAULT_BASE = 'http://127.0.0.1:8787'
const FAIL_OPEN_TIMEOUT_MS = 1_500

interface RiskResponse {
  tool: string
  requires_approval: number
  verboten: number
  verdict: 'allow' | 'ask' | 'deny'
  explanation: string
}

async function askSidecar(base: string, exec: ToolExecution): Promise<RiskResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FAIL_OPEN_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/risk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: exec.name, arguments: exec.arguments, reason: '' }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`sidecar /risk HTTP ${res.status}`)
    return (await res.json()) as RiskResponse
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const base = config.sidecarBaseUrl ?? DEFAULT_BASE

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    let risk: RiskResponse
    try {
      risk = await askSidecar(base, exec)
    } catch (error) {
      // fail-open：sidecar 挂了不让 agent 全瘫，但至少要记录。
      ctx.logger?.warn?.('system-one-guard: sidecar unreachable, failing open', error)
      return next()
    }
    console.log(
      `[system-one-guard] ${exec.name} -> ${risk.verdict}`
      + `  (severity=${risk.requires_approval?.toFixed?.(2) ?? risk.requires_approval}`
      + ` verboten=${risk.verboten?.toFixed?.(2) ?? risk.verboten}| ${risk.explanation})`,
    )
    if (risk.verdict === 'allow') return next()
    if (risk.verdict === 'ask') {
      return { kind: 'ask', reason: `system-one: ${risk.explanation}` }
    }
    return { kind: 'deny', reason: `system-one: ${risk.explanation}` }
  })
}
