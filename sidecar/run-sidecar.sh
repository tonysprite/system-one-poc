#!/bin/bash
#
# System-One sidecar launcher (DSH decision bundle backend).
# Runs the laya FastAPI router on 127.0.0.1:8787 with the calibrated operating
# point. Used both interactively and by the launchd LaunchAgent.
#
set -euo pipefail

VENV=/Users/tonysprite/projects/git.7k7k.com/laya-demo/.venv
HF_HOME_DIR=/Users/tonysprite/projects/git.7k7k.com/laya-demo/.hf
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SRC_DIR}/.." && pwd)"
LOG="${TMPDIR:-/tmp}/system-one-sidecar.log"

# Calibrated operating point (score_eval.py --history 合并后推荐)。
export HF_HOME="${HF_HOME_DIR}"
export S1_ASK_SEV="${S1_ASK_SEV:-1.2}"
export S1_DENY_SEV="${S1_DENY_SEV:-1.8}"
export S1_DENY_VERB="${S1_DENY_VERB:-0.7}"

exec "${VENV}/bin/python" -m uvicorn server:app \
  --app-dir "${ROOT}/sidecar" \
  --host 127.0.0.1 \
  --port 8787 \
  --log-level info >> "${LOG}" 2>&1
