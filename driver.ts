/**
 * 端到端 driver：用 DSH 真实的 ToolRuntime + ApprovalService + 我们写的
 * system-one-guard 插件，驱动真实工具调用，展示 allow / ask / deny 三态。
 *
 * 运行前需先在本机启动 laya sidecar（见 README），然后：
 *   node_modules/.bin/tsx tmp/system-one-poc/driver.ts
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as systemOneGuard } from './plugin/system-one-guard.ts'

// 最小 Agent 占位 —— 让 ask 能通过 ApprovalService 的审批通道路由，和
// dsh-tools 自身测试的 fakeAgent 一致。
const fakeAgent: Agent = {
  session: { events: [{ type: 'turn/start' }], append: () => ({}) },
} as unknown as Agent

async function main() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(systemOneGuard, { sidecarBaseUrl: 'http://127.0.0.1:8787' })

  // 模拟"人类审批席"：自动放行每一个 ask。换成 'rejected' 就能演示拒绝路径。
  ctx.on('approval/request', (req) => {
    console.log(`  [approval-seam] ${req.toolName}: "${req.reason}" -> granted`)
    return Promise.resolve('allowed-once' as const)
  })

  // 注册两个真实的 DSH 工具
  ctx.tools.register(defineTool({
    name: 'read_note',
    description: 'read a note file',
    parameters: { path: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) { console.log(`    >> read_note("${args.path}") 执行中...`); return 'file contents...' },
  }))
  ctx.tools.register(defineTool({
    name: 'run_sql',
    description: 'run a SQL statement',
    parameters: { statement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) { console.log(`    >> run_sql("${args.statement}") 执行中...`); return 'rowcount: N' },
  }))

  const signal = new AbortController().signal
  const calls = [
    { name: 'read_note', arguments: { path: 'logs/app.log' } },
    { name: 'run_sql', statement: 'SELECT * FROM users' },
    { name: 'run_sql', statement: 'DELETE FROM users WHERE 1=1' },
    { name: 'run_sql', statement: 'DROP DATABASE prod_customers' },
  ]

  console.log(`\n========== 端到端：system-one-guard 拦截工具调用 ==========\n`)
  for (const c of calls) {
    console.log(`--- 调用 ${c.name}(${JSON.stringify(c.arguments ?? { statement: c.statement })}) ---`)
    const args = c.arguments ?? { statement: c.statement }
    const result = await ctx.tools.execute({
      signal, callId: CallId(`call-${c.name}-${Math.random().toString(36).slice(2, 6)}`),
      name: c.name, arguments: args, agent: fakeAgent,
    })
    const firstText = result.content?.[0]?.text ?? ''
    console.log(`  结果: ${result.isError ? 'BLOCKED ❌' : 'OK ✅'}  ${String(firstText).slice(0, 90)}\n`)
  }

  await ctx.stop?.()
}

/** 第二个场景：给定任务文本，sidecar 从工具池重排 top-k（MCP 上百工具时省 token/省推理）。 */
async function demoShortlist() {
  const pool = [
    { name: 'grep_search', description: 'regex search inside file contents' },
    { name: 'list_files', description: 'list files in a directory' },
    { name: 'read_file', description: 'read a file' },
    { name: 'git_push', description: 'push branch to a remote' },
    { name: 'rm_dir', description: 'recursively delete a directory' },
    { name: 'run_sql', description: 'run a SQL statement against the database' },
    { name: 'post_payment', description: 'charge a customer credit card' },
    { name: 'deploy_release', description: 'publish a version to production' },
  ]
  const state = 'Find every TODO comment across the repository and list file:line for each.'
  const res = await fetch('http://127.0.0.1:8787/shortlist', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, tools: pool, top_k: 3 }),
  })
  const data = (await res.json()) as { ranked: string[]; scores: Record<string, number> }
  console.log('\n========== 场景二：工具短名单重排 /shortlist ==========')
  console.log(`任务: ${state}`)
  for (const [i, name] of data.ranked.entries()) {
    console.log(`  #${i + 1} ${name}  (p(fit)=${data.scores[name]?.toFixed(2)})`)
  }
  console.log()
}

await demoShortlist()

main().catch((err) => { console.error('driver failed:', err); process.exit(1) })
