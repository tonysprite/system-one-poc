/**
 * 端到端演示：system-one-shortlist 插件把 assembly.tools 按任务压缩到 top-k。
 *
 * 跑法：先在本机启动 sidecar（README），然后（同一 shell 内，因为沙箱按
 * shell 隔离网络命名空间）：
 *   node_modules/.bin/tsx tmp/system-one-poc/driver-shortlist.ts
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as systemOneShortlist } from './plugin/system-one-shortlist.ts'

// 用 DSH 真实工具面(名字/描述取自源码)注册一批工具，模拟一个中等规模的工具集。
const OUTPUT = {
  schema: { type: 'string' },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: String(v) }],
}
function tool(name: string, description: string, parameters: Record<string, unknown>) {
  return defineTool({ name, description, parameters, output: OUTPUT, async execute() { return '' } })
}
const TOOLS = [
  tool('read', 'Read a UTF-8 text file with line numbers.', { file_path: { type: 'string' } }),
  tool('write', 'Create or fully replace a UTF-8 text file.', { file_path: { type: 'string' } }),
  tool('edit', 'Edit an existing UTF-8 text file by replacing literal text.', { file_path: { type: 'string' } }),
  tool('grep', 'Search file contents with a ripgrep regular expression.', { pattern: { type: 'string' } }),
  tool('glob', 'Find files whose paths match a glob pattern.', { pattern: { type: 'string' } }),
  tool('bash', 'Run a bash command and return stdout/stderr.', { command: { type: 'string' } }),
  tool('todo_write', 'Record and update a structured task list.', { todos: { type: 'array' } }),
  tool('get_goal', 'Read the current same-session completion goal.', {}),
  tool('web_search', 'Search the web for current information.', { queries: { type: 'array' } }),
  tool('web_fetch', 'Fetch the content of a specific HTTP(S) URL and return it decoded to text.', { url: { type: 'string' } }),
  tool('run_sql', 'Run a SQL statement against the database.', { statement: { type: 'string' } }),
  tool('subagent', 'Delegate a self-contained task to a subagent.', { prompt: { type: 'string' } }),
]

async function main() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const t of TOOLS) ctx.tools.register(t)

  // 先不挂插件，取"未压缩"基线
  const before = (await ctx.systemPrompt.assemble()).tools.map((t) => t.name)
  console.log(`工具总数: ${before.length}`)
  console.log('压缩前 (全部): ' + before.join(', '))

  const task =
    'Find every TODO comment across the repository and list file:line for each one.'

  await ctx.plugin(systemOneShortlist, {
    sidecarBaseUrl: 'http://127.0.0.1:8787',
    topK: 3,
    protect: ['bash'], // 永远保留核心工具
    fallbackTask: task,
  })

  const after = (await ctx.systemPrompt.assemble()).tools.map((t) => t.name)
  console.log('\n压缩后的工具集 (top-k, bash 受保护保留):')
  console.log(after.join(', '))

  await ctx.stop?.()
}

main().catch((err) => { console.error('driver failed:', err); process.exit(1) })
