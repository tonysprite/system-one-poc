# System-One × DSH — Ops Runbook

把 System-One（laya）决策接入 DSH 会话决策的**生产化操作文档**：打包、装机、常驻、
验证、运维、回滚。对应 DSH 侧的三个自动挂载点 `tools/pre-execute` /
`system-prompt/assemble` / `approval/request`。

---

## 1. 架构

```
DSH session (profile tree, host plane)
 ├─ system-one-guard      tools/pre-execute        allow/ask/deny 三态审批
 ├─ system-one-shortlist  system-prompt/assemble   请求侧工具 top-k 压缩
 └─ approval-logger       approval/request         人审决定回流 JSONL
        │  HTTP 127.0.0.1:8787
        ▼
launchd: com.tonysprite.dsh-system-one-sidecar
        └─ sidecar/server.py (FastAPI + laya Router, preload)
```

三个插件是 **host 平面**行，监听 agent 作用域事件经祖先传播到达（同
`repeat-tool-reminder` 先例），因此对 profile 的每个会话都生效。sidecar 不可达时
全部 **fail-open**（放行 + 记日志），不会让 DSH 宕掉，但决策不生效。

## 2. 组件清单

| 路径 | 作用 |
| --- | --- |
| `bundle/package.json` | bundle 清单，`dsh.bundle.patch` 声明 |
| `bundle/cordis.patch.yml` | 三行插件的装载配置（加/删行在此） |
| `bundle/lib/*.js` | 插件编译产物（零 `@deepseek-ai` 运行时依赖） |
| `bundle/build.mjs` | `plugin/*.ts` → `bundle/lib/*.js` 构建脚本 |
| `sidecar/server.py` | laya FastAPI 服务（`/risk` `/shortlist`） |
| `sidecar/run-sidecar.sh` | 常驻启动脚本（HF_HOME + 校准阈值） |
| `sidecar/com.tonysprite.dsh-system-one-sidecar.plist` | launchd 模板（本仓库） |
| `~/Library/LaunchAgents/com.tonysprite.dsh-system-one-sidecar.plist` | 实际安装的 launchd 单元 |

## 3. 安装三步

### 3.1 打包（一次性，已在仓库内）

`bundle/` 已是可装 bundle。重新编译（改过 `plugin/*.ts` 后）：

```bash
cd /Users/tonysprite/projects/github.com/tonysprite/system-one-poc
node bundle/build.mjs        # DSH_CHECKOUT 可覆盖 deepseek-harness 检出路径
```

### 3.2 装入 profile（决定哪些会话启用）

```bash
DSH=/Users/tonysprite/projects/github.com/deepseek-harness/apps/cli/lib/bin.js
node "$DSH" plugin --profile web add \
  /Users/tonysprite/projects/github.com/tonysprite/system-one-poc/bundle
```

这会 pnpm-install 该 bundle 并把 `@tonysprite/system-one-poc` 追进
`~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles`。**生效时机**：bundle
堆栈在会话**启动时**读取，已运行的 GUI 需要重启才挂载（`cordis.patch.yml` 才热重载）。

> `dsh.profile.bundles` 是 profile 全局的；想只在个别 profile 启用就只对那个 profile 装。

### 3.3 常驻 sidecar（每台机一次性）

```bash
# 1. 把单元装进 launchd（把工作机上的 plist 与仓库模板保持一致）
cp sidecar/com.tonysprite.dsh-system-one-sidecar.plist \
   ~/Library/LaunchAgents/com.tonysprite.dsh-system-one-sidecar.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tonysprite.dsh-system-one-sidecar.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tonysprite.dsh-system-one-sidecar.plist

# 前台调试（可选，绕过 launchd）：
sidecar/run-sidecar.sh
```

前置（只在一台机首次准备）：laya venv 在
`/Users/tonysprite/projects/git.7k7k.com/laya-demo/.venv`，HF 缓存 `…/.hf`，
`sidecar/run-sidecar.sh` 里 `VENV`/`HF_HOME_DIR`/阈值可按机覆盖。

## 4. 验证

```bash
# 组合树已含三行
node "$DSH" --profile web --dump-config | grep -A2 -E "system-one|approval-logger"

# sidecar 健康
curl -s http://127.0.0.1:8787/risk -H 'content-type: application/json' \
  -d '{"tool":"read_file","arguments":{"path":"/tmp/x"}}'
# -> {"tool":"read_file","requires_approval":…,"verboten":…,"verdict":"allow|ask|deny","explanation":…}

# 三态覆盖（实测应 allow/ask/deny 各一）
curl -s …/risk -d '{"tool":"read_file","arguments":{"path":"/tmp/x"}}'
curl -s …/risk -d '{"tool":"bash","arguments":{"cmd":"ps aux"}}'
curl -s …/risk -d '{"tool":"bash","arguments":{"cmd":"DROP DATABASE prod"}}'

# launchd 常驻状态
launchctl print gui/$(id -u)/com.tonysprite.dsh-system-one-sidecar | grep -E "state|pid"
```

## 5. 日间运维

### 5.1 关/开某个能力（不卸载）

编辑 `bundle/cordis.patch.yml`，删行或 `disabled: true`：
```yaml
- id: system-one-shortlist
  disabled: true      # 关闭工具压缩；guard/logger 不受影响
```
`cordis.patch.yml` 属于 profile 用户层热重载吗？——**否**，bundle 层的 patch 只在重启时
重读。改完需重启 dsh 会话（或临时在 `~/.dsh/profiles/web/cordis.patch.yml` 里按
`id` 覆盖 config/disabled，那个是热重载的）。

### 5.2 换操作点（降审批噪音 / 收紧危险拦截）

改 `sidecar/run-sidecar.sh` 的 `S1_ASK_SEV` / `S1_DENY_SEV` / `S1_DENY_VERB` 后重启
sidecar；推荐值由评分器给出：
```bash
$VENV/bin/python calibration/score_eval.py --history calibration/approval-history.jsonl --threshold-sweep
```
当前部署：`S1_ASK_SEV=1.2 S1_DENY_SEV=1.8 S1_DENY_VERB=0.7`（合并评估集+历史回流后推荐）。

### 5.3 审计

- guard 每次决策 `console` 打 `[system-one-guard] <tool> -> <verdict> (severity=… verboten=…| explanation)`。
- 人审回流追加写 `calibration/approval-history.jsonl`（**gitignored**，不回传）。
- sidecar 日志：`/tmp/system-one-sidecar.log` / `.err.log`。

## 6. Troubleshooting

| 症状 | 排查 |
| --- | --- |
| guard/shortlist 失效但 DSH 正常 | sidecar 未起 → 查 `launchctl print …`、`/tmp/system-one-sidecar*.log`；fail-open 是预期 |
| 端口被占 / 8787 冲突 | 改 `run-sidecar.sh` 与 `cordis.patch.yml` 的 `sidecarBaseUrl` 同改 |
| launchd 崩循环 | 单元 `KeepAlive`，先 `bootout` 停掉，前台跑 `run-sidecar.sh` 看堆栈 |
| 重启后又没了 | 确认 `dsh.profile.bundles` 仍含 `@tonysprite/system-one-poc`，且 profile 没被重建 |
| 模型加载慢/内存大 | `Router(preload=True)` 常驻，启动约 20s；调 `ProcessType`/内存按部署 |

## 7. 回滚 / 卸载

```bash
# 卸载 bundle（从 bundles 列表移除 + 移除依赖）
node "$DSH" plugin --profile web rm @tonysprite/system-one-poc

# 停并卸载 sidecar 服务（不删文件）
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tonysprite.dsh-system-one-sidecar.plist
rm ~/Library/LaunchAgents/com.tonysprite.dsh-system-one-sidecar.plist   # 或保留模板
```

## 8. 风险与校准提醒（原文重申）

- POC 级判定：**deny 无漏放**（deny precision=1.00），但 **ask 噪音偏高**——按当前
  操作点连 `read_file` 都会被 ask（安全侧“拿不准就请人看”）。
- `shortlist` 排序仍偏**关键字**，压缩结果未必最优；默认保守（topK=6/保护集），
  上生产前建议先建“正确工具选择”标注集再收紧。
- 上生产前必须用**真实审批样本**回流重定操作点（见 §5.2），不要全局套用单看历史扫出的阈值。
