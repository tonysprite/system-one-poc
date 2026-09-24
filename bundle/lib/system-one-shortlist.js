export const name = 'system-one-shortlist';
const DEFAULT_BASE = 'http://127.0.0.1:8787';
const TIMEOUT_MS = 1_500;
/** 从一条 user message 的 content block 里拼出文本。 */
function messageText(message) {
    return (message.content ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n');
}
async function shortlist(base, task, tools, topK) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/shortlist`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                state: task,
                tools: tools.map((t) => ({ name: t.name, description: t.description })),
                top_k: topK,
            }),
            signal: controller.signal,
        });
        if (!res.ok)
            throw new Error(`sidecar /shortlist HTTP ${res.status}`);
        const data = (await res.json());
        return data.ranked.filter((name) => tools.some((t) => t.name === name));
    }
    finally {
        clearTimeout(timer);
    }
}
export function apply(ctx, config = {}) {
    const base = config.sidecarBaseUrl ?? DEFAULT_BASE;
    const topK = config.topK ?? 3;
    const minTools = config.minToolsToCompress ?? topK;
    const protect = config.protect ?? [];
    const protectSet = new Set(protect);
    const taskByAgent = new WeakMap();
    // 从 agent/pre-step 声明的最新用户输入里抓任务文本（按 agent 缓存）。
    // 用户打断消息也会走到这里，用它当"最近任务"是合理近似。
    ctx.on('agent/pre-step', ({ agent, messages }, next) => {
        const userText = (messages ?? [])
            .filter((m) => m.source?.kind === 'user')
            .map((m) => messageText(m))
            .filter(Boolean)
            .join('\n');
        if (userText)
            taskByAgent.set(agent, userText);
        return next();
    });
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        try {
            if (assembly.tools.length <= minTools)
                return next(); // 没必要压缩
            // 任务文本：taskProvider > agent/pre-step 缓存 > fallbackTask
            let task = config.taskProvider?.(ctx, assembly);
            if (!task && context?.scope && taskByAgent.has(context.scope)) {
                task = taskByAgent.get(context.scope);
            }
            if (!task)
                task = config.fallbackTask;
            if (!task || !task.trim())
                return next();
            const tools = assembly.tools;
            const ranked = await shortlist(base, task.trim(), tools, topK);
            // 组装结果集：ranked top-k + 受保护工具（去重、保序）
            const byName = new Map(tools.map((t) => [t.name, t]));
            const selected = [];
            const seen = new Set();
            for (const name of [...ranked, ...protect]) {
                const tool = byName.get(name);
                if (tool && !seen.has(name)) {
                    seen.add(name);
                    selected.push(tool);
                }
            }
            // 万一 top-k 不足（sidecar 只回了部分），把剩余受保护/未选工具按原顺序补到 topK
            for (const tool of tools) {
                if (selected.length >= topK + protect.length)
                    break;
                if (!seen.has(tool.name)) {
                    seen.add(tool.name);
                    selected.push(tool);
                }
            }
            if (selected.length === tools.length)
                return next(); // 全保留了，等于没压缩
            console.log(`[system-one-shortlist] ${tools.length} tools -> ${selected.length}`
                + ` (ranked: ${ranked.join(', ')})`);
            return { ...assembly, tools: selected };
        }
        catch (error) {
            ctx.logger?.warn?.('system-one-shortlist: failed, skipping compression', error);
            return next();
        }
    });
}
