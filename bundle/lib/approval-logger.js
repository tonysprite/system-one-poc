import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export const name = 'approval-logger';
const DEFAULT_OUTPUT = 'tmp/system-one-poc/calibration/approval-history.jsonl';
export function apply(ctx, config = {}) {
    const output = config.outputPath ?? DEFAULT_OUTPUT;
    mkdirSync(dirname(output), { recursive: true });
    // callId -> 本次工具调用（含 arguments），供 approval/request 合并
    const pending = new Map();
    ctx.on('tools/pre-execute', (exec, next) => {
        pending.set(String(exec.callId), exec);
        return next();
    });
    // 包一层 next()：把 outcome 也记下来（waterfall：next() 才走到评审员/真人）
    ctx.on('approval/request', async (req, next) => {
        const outcome = await next();
        const exec = req.callId ? pending.get(String(req.callId)) : undefined;
        const record = {
            ts: new Date().toISOString(),
            tool: req.toolName,
            arguments: exec?.arguments,
            reason: req.reason,
            outcome,
            source: 'human',
        };
        appendFileSync(output, JSON.stringify(record) + '\n');
        return outcome;
    });
}
