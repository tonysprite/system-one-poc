# @tonysprite/system-one-poc — DSH bundle

把 System-One（laya 决策）挂进 DSH 的正式 bundle：声明 `dsh.bundle.patch`，
被 `dsh --profile web`（以及其他把本 bundle 加入 `dsh.profile.bundles` 的 profile）
在**会话启动时自动加载**，无需手动跑 driver。

## 组成

| 行 id | 模块 | 挂接点 | 作用 |
| --- | --- | --- | --- |
| `system-one-guard` | `./guard` | `tools/pre-execute` | 每次工具调用的 allow/ask/deny 三态决策（laya `/risk`，不可达 fail-open） |
| `system-one-shortlist` | `./shortlist` | `system-prompt/assemble` | 请求侧把工具集压缩成 top-k（laya `/shortlist`，不可达/工具少时 fail-open） |
| `approval-logger` | `./approval-logger` | `approval/request` | 把人审决定回流成 JSONL（重新标定操作点用） |

三个都是 host 平排行，监听 agent 作用域事件经祖先传播到达（同 `repeat-tool-reminder`
先例），因此对 web/headless 每个会话都生效。

## 为什么运行时零依赖

`plugin/*.ts` 对 `@deepseek-ai/*` 全部是 `import type`，编译后只剩 Node 内置模块
（`fetch` / `node:fs` / `node:path`）。所以 `lib/` 产物不需要安装任何 `@deepseek-ai`
包——bundle 装上即可跑。`package.json` 里的 peerDependencies 只用于类型上下文。

## 构建

```bash
node bundle/build.mjs                 # 重新编译 plugin/*.ts -> bundle/lib/*.js
# 需要类型解析时，DSH_CHECKOUT 指向 deepseek-harness 检出目录
```

## 接入 profile（一次性）

```bash
# web（GUI）profile：
dsh plugin --profile web add /Users/tonysprite/projects/github.com/tonysprite/system-one-poc/bundle
# 其它 profile 同理替换名字。
# 这会 pnpm-install 该 bundle 到 profile 并把 @tonysprite/system-one-poc 追加进
# dsh.profile.bundles —— 之后每次 dsh 会话启动都会自动挂载。
```

## 前置：sidecar 必须常驻

三个插件都依赖 `127.0.0.1:8787` 的 laya sidecar；sidecar 不在时会 fail-open
（guard/shortlist 放行 + 记日志），不会让 DSH 宕掉，但决策不生效。

```bash
sidecar/run-sidecar.sh        # 前台跑（HF_HOME + 校准阈值 S1_ASK_SEV=1.2 S1_DENY_SEV=1.8 S1_DENY_VERB=0.7）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tonysprite.dsh-system-one-sidecar.plist
```

## 运维

- **关掉某个行**：删除/`disabled: true` 对应行 `bundle/cordis.patch.yml`（profile 层
  热重载，下次重组即生效），或从 `dsh.profile.bundles` 移除再 `dsh plugin --profile web rm @tonysprite/system-one-poc`。
- **换操作点**：改 `sidecar/run-sidecar.sh` 里的 `S1_*` 并重启 sidecar（评分器
  `calibration/score_eval.py --history` 出的推荐值再下发）。
- **审计**：guard 每次决策打印 `[system-one-guard] <tool> -> <verdict>`；审批回流在
  `calibration/approval-history.jsonl`。

⚠️ 校准提醒：这是 POC 级判定（见仓库根 README 的诚实结论），deny 无漏放但
ask 噪音偏高、shortlist 排序仍偏关键字。上生产前先用真实审批样本重定操作点。
