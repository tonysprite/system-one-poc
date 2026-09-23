"""System-One 决策 sidecar：预加载 laya，向 DSH 提供 /risk 与 /shortlist。

这是一个最小 POC 服务：把「工具调用风险分级」和「工具短名单重排」两件事
从 DSH(TS) 侧拆到 Python 侧，用 laya 的类型化决策(choice/score/noul) 完成。

启动：
  venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8787
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from pydantic import BaseModel, Field

from laya import Router

app = FastAPI(title="system-one-sidecar")

# 预加载 laya Router（三套 checkpoint），首问即可 33ms 级响应
_router = Router(preload=True)


class RiskRequest(BaseModel):
    """一次待审批的工具调用。state 足够 laya 判断风险即可。"""

    tool: str
    arguments: dict = Field(default_factory=dict)
    reason: str = ""


class RiskResponse(BaseModel):
    tool: str
    requires_approval: float  # p(yes): 需要人审批
    verboten: float  # p(yes): 必须拒绝、绝不执行
    verdict: str  # allow | ask | deny
    explanation: str


class ToolCandidate(BaseModel):
    name: str
    description: str


class ShortlistRequest(BaseModel):
    state: str
    tools: list[ToolCandidate]
    top_k: int = 3


class ShortlistResponse(BaseModel):
    ranked: list[str]
    scores: dict[str, float]


def _verdict(severity: float, verboten_p: float) -> tuple[str, str]:
    """把 score 严重度 + verboten 概率映射到 allow/ask/deny 三态。

    severity 档位: 0 benign, 1 warning, 2 dangerous, 3 catastrophic
    阈值可用环境变量覆盖(评分器定操作点后下发部署):
      S1_ASK_SEV / S1_DENY_SEV / S1_DENY_VERB
    判定顺序: 先看 verboten(不可逆破坏不看置信度直接拒)，再看严重度。
    """
    ask_sev = float(os.environ.get("S1_ASK_SEV", "1.5"))
    deny_sev = float(os.environ.get("S1_DENY_SEV", "2.7"))
    deny_verb = float(os.environ.get("S1_DENY_VERB", "0.7"))
    if verboten_p >= deny_verb or severity >= deny_sev:
        return "deny", "destructive and irreversible"
    if severity >= ask_sev:
        return "ask", "risky enough to require human approval"
    return "allow", "low risk"


@app.post("/risk", response_model=RiskResponse)
def risk(req: RiskRequest) -> RiskResponse:
    args_txt = ", ".join(f"{k}={v}" for k, v in (req.arguments or {}).items()) or "(no args)"
    state = (
        f"An agent proposes to call tool '{req.tool}' with arguments [{args_txt}], "
        f"saying: {req.reason or '(none given)'}. It runs in a developer's "
        f"environment with access to real infra and customer data.\n"
    )
    questions = {
        "severity": {
            "type": "score",
            "instructions": "Rate how risky this proposed action is for an autonomous coding agent.",
            "criteria": [
                "benign: reads, local temp writes, no external effect",
                "warning: changes local dev files, runs commands, fetch-only git",
                "dangerous: writes prod data, mutates shared infra, charges money, deletes data, force-push, deploys, revokes credentials",
                "catastrophic: irreversible destruction - drop/truncate prod DB, mass delete, disable auth, nuke whole env",
            ],
        },
        "verboten": {
            "type": "noul",
            "instructions": (
                "Is this action destructive and irreversible such that it must "
                "NEVER be allowed, even with human approval (drop/truncate a "
                "production database, cascade delete everything, disable all "
                "credentials)? Answer yes only for catastrophic class actions."
            ),
        },
    }
    res = _router.predict(state, questions)
    severity = res["answers"]["severity"]["score"]
    verboten_p = res["answers"]["verboten"]["noul"]
    verdict, explanation = _verdict(severity, verboten_p)
    return RiskResponse(
        tool=req.tool,
        requires_approval=severity,
        verboten=verboten_p,
        verdict=verdict,
        explanation=explanation,
    )


@app.post("/shortlist", response_model=ShortlistResponse)
def shortlist(req: ShortlistRequest) -> ShortlistResponse:
    """给一段任务文本，从工具池里重排出最合适的 top_k。

    实现：对每个候选工具建一个 noul 问题「这个工具适合当前任务吗」，
    一次并行调用全部回答，按 p(yes) 排序取前 k。适合工具集上百个的 MCP 场景。
    """
    if not req.tools:
        return ShortlistResponse(ranked=[], scores={})
    state = f"The current task for the agent:\n{req.state}\n"
    questions = {}
    for t in req.tools:
        questions[t.name] = {
            "type": "noul",
            "instructions": (
                f"Given the agent's current task, is the tool '{t.name}' directly "
                f"needed to perform an operation the task requires? "
                f"What it does: {t.description}. "
                f"Judge by FUNCTION fit to the task's concrete operations, not by "
                f"loose keyword overlap. Only pick tools that actually execute an "
                f"operation this task asks for."
            ),
        }
    res = _router.predict(state, questions)
    scores = {name: res["answers"][name]["noul"] for name in questions}
    ranked = sorted(scores, key=scores.get, reverse=True)[: req.top_k]
    return ShortlistResponse(ranked=ranked, scores=scores)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8787)
