# system-one-poc

把 **System One 决策引擎**（[laya](https://pypi.org/project/laya/)，本地、非自回归、
~33ms/问、答 [[choice/score/noul|<answer>]] 型问题）接进 **DeepSeek Harness (DSH)** 的决策
漏斗，做三件事：

1. **工具调用三态审批** —— 对每个 `tools/pre-execute` 自动给出 `allow / ask / deny`
   （`ask` 自然流入 DSH 审批通道，`deny` 在 dispatch 前拦截）。
2. **请求侧工具压缩** —— 根据当前任务把全量工具 schema 压成 top-k，省 token、少分心。
3. **真实审批样本回流打标** —— 把人审的结果写回历史，重跑评分器定可辩护的操作点。

## 一图看懂

```
                    ┌─────────────────────────────┐
 agent step ─────▶ │  DSH hook 链 (cordis events) │
                    └─────────────┬───────────────┘
             tools/pre-execute    │   system-prompt/assemble
                    ▼             │            ▼
            system-one-guard.ts   │   system-one-shortlist.ts
                    │             │            │
                    ▼             │            ▼
              ┌───────────────────┴──────────────────┐
              │   sidecar/server.py (FastAPI + laya)│
              │   POST /risk      → allow/ask/deny  │
              │   POST /shortlist → tool top-k      │
              └──────────────────────────────────────┘
```

## 结构

```
system-one-poc/
├── sidecar/server.py          Python FastAPI + 预加载 laya Router
│                                POST /risk      : 一次工具调用的 allow/ask/deny 判定
│                                POST /shortlist : 任务文本 → 工具 top-k 重排
├── plugin/
│   ├── system-one-guard.ts    DSH 插件：挂 tools/pre-execute 调 /risk
│   ├── system-one-shortlist.ts DSH 插件：挂 system-prompt/assemble 压缩工具集
│   └── approval-logger.ts     审批回流插件：approval/request 结果 → 历史 JSONL
├── driver.ts                  端到端: risk 三态审批（真实 ToolRuntime + ApprovalService）
├── driver-shortlist.ts        端到端: /shortlist 请求侧工具压缩
├── capture-approvals.ts       回流采集驱动：真实 hook 链 + 评审员标 outcome
├── calibration/
│   ├── eval-set.json          31 条人工标注的审批 ground truth
│   └── score_eval.py          评分器：混淆矩阵/每类 P/R/F1 + 阈值扫描(--history 合并)
└── calibrate.py / calib_curl.py  离线/线上标定脚本
```

## 为什么用 System One？

普通 LLM 做一次"该不该批准"要几秒、要流式、要带整套 prompt；System One 模型把决策
压成**本地、毫秒级、可解释的单点判定**——正好嵌进 dispatch 前的热路径，且决策概率
（`severity` / `verboten`）可量化、可标定、可设操作点。这正是"拿 system-one 提升 agent
决策流程"的最小落地形态。

> **性质说明**：这是 POC，用于展示 hook 架构 + System One 三态决策可行。laya 尚未在
> DSH 专属问题上深度校准，阈值与 prompt 都是演示级；**上生产前必须按真实样本标定**。

## 快速开始（sidecar，纯 Python，独立可跑）

```bash
python -m venv .venv && source .venv/bin/activate
pip install laya fastapi uvicorn

# 首跑会下载模型到 HF 缓存（约几百 MB）
python -m uvicorn server:app --app-dir sidecar --host 127.0.0.1 --port 8787
```

打点验证：

```bash
curl -s localhost:8787/risk \
  -H 'content-type: application/json' \
  -d '{"tool":"run_sql","arguments":{"statement":"DROP DATABASE prod"}}'
# → {"verdict":"deny", "requires_approval":..., "verboten":..., "explanation":"..."}

curl -s localhost:8787/risk \
  -H 'content-type: application/json' \
  -d '{"tool":"run_sql","arguments":{"statement":"SELECT * FROM users"}}'
# → {"verdict":"ask", ...}
```

**阈值可环境变量热切换**（默认 `ask_sev=1.5 / deny_sev=2.7 / deny_verb=0.7`）：

```bash
S1_ASK_SEV=1.2 S1_DENY_SEV=1.8 S1_DENY_VERB=0.7 python -m uvicorn server:app --app-dir sidecar ...
```

## DSH 集成（TS 插件 / drivers）

TS 层依赖 DSH 的 `@deepseek-ai/*` 内部包
（`cordis` / `dsh-tools` / `dsh-system-prompt` / `dsh-user-approval` / `dsh-agent` /
`dsh-llm`），**需要在 DSH 检出的 workspace 里跑**（`node_modules/.bin/tsx` 经
tsconfig paths 解析到源码）。在没有 DSH 的环境里，TS 文件是**参考/集成示例**：展示
每个 hook 怎么挂、决策怎么回流。

> ✅ **正式接入（自动加载）**：`bundle/` 已是声明了 `dsh.bundle.patch` 的正式 bundle，
> 装入 profile 后每次会话启动自动挂载（无需手动跑 driver）。安装/常驻/验证/回滚/
> 运维见 **[`OPS.md`](./OPS.md)**。三态判定、工具压缩、审批回流仍依赖
> `127.0.0.1:8787` 的 laya sidecar，sidecar 不在时 fail-open。

挂载方式（DSH 插件）：

```ts
import { apply as guard } from './plugin/system-one-guard.ts'
import { apply as shortlist } from './plugin/system-one-shortlist.ts'
import { apply as approvalLogger } from './plugin/approval-logger.ts'

// 在 DSH Context 上按序安装；guard 负责裁决，logger 负责把人的决定写回历史
ctx.plugin(guard, { endpoint: 'http://127.0.0.1:8787' })
ctx.plugin(shortlist, { endpoint: 'http://127.0.0.1:8787' })
ctx.plugin(approvalLogger, { historyFile: 'calibration/approval-history.jsonl' })
```

> ⚠️ 插件注册顺序有讲究：`approval-logger` 与 guard 都挂 `tools/pre-execute`，而 cordis
> 水瀑布是**短路**的——guard 返回 ask/deny 时不调 `next()`，会截断后面的监听器。所以
> **必须先注册 logger（含 per-callId 缓存）再注册 guard**，否则历史里 arguments 全是空、
> 且不会记到被拒的调用。详见 `capture-approvals.ts`。

## 校准 / 回流打标（评分器）

`calibration/score_eval.py` 对每条样本跑 sidecar `/risk`，再对**当前阈值**算混淆矩阵 /
每类 P/R/F1，并提供**阈值扫描**（网格找最小化加权重判代价的操作点，误放行代价最重）：

```bash
# sidecar 与评分器必须在同一 shell（网络命名空间隔离时）
$VENV/bin/python -m uvicorn server:app --app-dir sidecar --host 127.0.0.1 --port 8787 &
$VENV/bin/python calibration/score_eval.py \
  --history calibration/approval-history.jsonl --threshold-sweep
```

`--history` 把**审批回流样本**并入基础评估集再扫（回流打标映射：
`allowed-once→allow / rejected→deny / cancelled→ask`）。这样扫出的操作点才是对全空间有
效的，而不是对"旧阈值下被 ask 过的子集"局部最优。

**诚实结论（一次代表性读数，49 = 31 eval-set + 18 history）**：

- 旧阈值 `ask_sev=1.5 / deny_sev=2.7 / deny_verb=0.7` 下 deny recall 只有 ~0.35：
  `git push --force / redis-cli FLUSHALL / kubectl rollout restart / rm -rf` 这批"实际被
  拒"的操作，laya 只给 sev 1.7–1.9、verboten 0.55–0.66，全在旧 deny 阈值以下 → 被做成 ask。
- 全网格扫描（`deny_sev` 也纳入）给出的推荐操作点 **`ask_sev=1.2 / deny_sev=1.8 /
  deny_verb=0.7`**：保住两个安全零 `benign→deny=0`、`deny→allow=0`，代价是较多 benign
  被 ask（审批噪音）——等价于"拿不准就请人看"。这是 laya 当前信号下正确的博弈。
- ⚠️ **选择偏差警告**：单看 history 扫出的操作点（如 ask_sev=2.0/deny_verb=0.4）**不要
  全局部署**——历史是被截断的子集，对它局部最优、对全局会翻车。

> laya 每轮不完全确定（score 会漂移），故以上为代表性读数。想做成可复现的 CI 门槛，
> 应在采集阶段把每次 `(severity, verboten)` 快照连同 outcome 一起落盘，评分器回放快照
> 而非实时重跑。

## 设计决策 / 注意点

- **跨语言**：laya 是 Python+torch，DSH 是 TS。POC 用 FastAPI HTTP sidecar 隔离；
  上生产可换 gRPC / Unix socket。模型 `Router(preload=True)` 常驻，首问即 33ms 级。
- **fail-open**：sidecar 不可达时插件记日志后放行，避免系统单点全瘫。生产请按安全
  策略决定（高风险域可能要 fail-closed）。
- **校准**：早期 noul 版 prompt 判别力差（所有案例挤在 0.1–0.3）；改成 **score 型
  severity + 明确枚举档位 + verboten noul** 后 allow/ask/deny 才干净分层
  （见 `sidecar/server.py` 的 questions）。这正是"system-one 需针对目标域校准"的证据。
- **审计**：当前 decision 只打印日志。生产应把每次 allow/ask/deny + 概率写入
  `tools/pre-execute` 的审计链条。

## License

MIT
