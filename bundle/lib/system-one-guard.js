export const name = 'system-one-guard';
/** 兜底基址与 fail-open 的超时。 */
const DEFAULT_BASE = 'http://127.0.0.1:8787';
const FAIL_OPEN_TIMEOUT_MS = 1_500;
async function askSidecar(base, exec) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FAIL_OPEN_TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/risk`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tool: exec.name, arguments: exec.arguments, reason: '' }),
            signal: controller.signal,
        });
        if (!res.ok)
            throw new Error(`sidecar /risk HTTP ${res.status}`);
        return (await res.json());
    }
    finally {
        clearTimeout(timer);
    }
}
export function apply(ctx, config = {}) {
    const base = config.sidecarBaseUrl ?? DEFAULT_BASE;
    ctx.on('tools/pre-execute', async (exec, next) => {
        let risk;
        try {
            risk = await askSidecar(base, exec);
        }
        catch (error) {
            // fail-open：sidecar 挂了不让 agent 全瘫，但至少要记录。
            ctx.logger?.warn?.('system-one-guard: sidecar unreachable, failing open', error);
            return next();
        }
        console.log(`[system-one-guard] ${exec.name} -> ${risk.verdict}`
            + `  (severity=${risk.requires_approval?.toFixed?.(2) ?? risk.requires_approval}`
            + ` verboten=${risk.verboten?.toFixed?.(2) ?? risk.verboten}| ${risk.explanation})`);
        if (risk.verdict === 'allow')
            return next();
        if (risk.verdict === 'ask') {
            return { kind: 'ask', reason: `system-one: ${risk.explanation}` };
        }
        return { kind: 'deny', reason: `system-one: ${risk.explanation}` };
    });
}
