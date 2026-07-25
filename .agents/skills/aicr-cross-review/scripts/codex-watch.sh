#!/usr/bin/env bash
# Codex background-job watchdog for cross-review.
# Usage: bash codex-watch.sh <job-id> [max-seconds=900] [interval-seconds=30]
#
# Polls a background codex-companion job and prints exactly one state token:
#   CODEX_DONE           job reached a terminal state (completed|failed|cancelled) — fetch its result by id (exit 0)
#   CODEX_DEAD           broker/worker dead per the reaper — job can NEVER complete (exit 2)
#   CODEX_STALL_TIMEOUT  still running after max-seconds (exit 3)
#   CODEX_NO_COMPANION   companion script not found (exit 4)
#
# PREREQUISITE: run inside Claude's plugin runtime (CLAUDE_PLUGIN_DATA set) so the
# reaper and the companion resolve the SAME state root. A plain terminal makes the
# companion fall back to a temp state dir while the reaper reads plugin-data — the
# probe would miss real state. Bare ad-hoc runs are for inspection only.
#
# LIVENESS: the reaper's own --dry-run --json is the authoritative probe — never a
# hand-rolled PID check (status --json exposes no broker pid) and never socket-file
# existence (a crashed broker leaves its socket file on disk). ANY reaper entry for
# our state dir / job id means stale — dead-pid AND missing-socket AND unparseable
# broker.json reasons all count; do not filter on the reason text.
#
# SCOPING: codex-reap iterates EVERY workspace under the plugin data root, so a dead
# broker from another repo/session/worktree would otherwise look like OUR job stalled.
# The state dir is "<slug>-<hash>" where slug = sanitized basename(workspaceRoot) and
# hash = sha256(realpath(workspaceRoot))[:16] (codex .../lib/state.mjs resolveStateDir).
# Basename alone is NOT enough — recompute the full key and match exactly; jobs match
# by our job id only.
#
# The 15-min default cap exists because the LLM legitimately generates for 10-15 min
# on complex reviews — a shorter threshold causes false-positive reaps of valid work.
set -uo pipefail

JOB_ID="${1:?usage: codex-watch.sh <job-id> [max-seconds] [interval]}"
MAX="${2:-900}"
INTERVAL="${3:-30}"

comp=$(ls -t ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | head -1)
if [ -z "$comp" ]; then echo "CODEX_NO_COMPANION"; exit 4; fi

WSROOT=$(node "$comp" status --all --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('workspaceRoot','') or '')" 2>/dev/null || true)
# If the companion failed to return a workspaceRoot, the state key would be
# computed from cwd (os.path.realpath('') == cwd) and hash the wrong path —
# the reaper would then miss the real dead broker, causing a 15-min stall.
# Guard: only compute STATEKEY when WSROOT is non-empty; an empty key causes
# the reaper probe to be skipped (guarded below), degrading to STALL_TIMEOUT.
STATEKEY=""
if [ -n "$WSROOT" ]; then
  STATEKEY=$(WSROOT="$WSROOT" python3 - <<'PY'
import os,re,hashlib
ws=os.environ.get('WSROOT','')
try: canon=os.path.realpath(ws)
except Exception: canon=ws
slug=re.sub(r'[^a-zA-Z0-9._-]+','-', os.path.basename(ws)); slug=re.sub(r'^-+|-+$','',slug) or 'workspace'
print(slug+'-'+hashlib.sha256(canon.encode()).hexdigest()[:16])
PY
)
fi

elapsed=0
while :; do
  # Retry WSROOT/STATEKEY if the initial companion status call failed (transient
  # truncation or startup delay). Without this, a single failed lookup permanently
  # disables dead-broker detection for the entire run, causing 15-min stall on
  # broker crashes that the reaper could have caught immediately.
  if [ -z "$STATEKEY" ]; then
    _RETRY_WSROOT=$(node "$comp" status --all --json 2>/dev/null | \
      python3 -c "import json,sys;print(json.load(sys.stdin).get('workspaceRoot','') or '')" 2>/dev/null || true)
    if [ -n "$_RETRY_WSROOT" ]; then
      STATEKEY=$(WSROOT="$_RETRY_WSROOT" python3 - <<'PY'
import os,re,hashlib
ws=os.environ.get('WSROOT','')
try: canon=os.path.realpath(ws)
except Exception: canon=ws
slug=re.sub(r'[^a-zA-Z0-9._-]+','-', os.path.basename(ws)); slug=re.sub(r'^-+|-+$','',slug) or 'workspace'
print(slug+'-'+hashlib.sha256(canon.encode()).hexdigest()[:16])
PY
)
    fi
  fi

  # Job-status check comes FIRST so a job that completed and then had its broker
  # die before the next poll returns CODEX_DONE (job result is fetchable) rather
  # than CODEX_DEAD (result would be lost). Dead-broker probe only runs when the
  # job is not yet terminal.
  # Query THIS job's status explicitly and accept only explicit terminal states
  # (completed|failed|cancelled per the companion's job model). Absence from a
  # snapshot is NOT completion: a transient empty status, stale ID, or state-read
  # race must keep the watchdog polling, never report CODEX_DONE without a result.
  # The companion exits nonzero when the job id is unknown — that also keeps polling.
  # NOTE: python3 -c (not `python3 - <<'PY'`) for the same reason as the reaper
  # probe above — the heredoc form discards the piped JSON.
  job_phase=$(node "$comp" status "$JOB_ID" --json 2>/dev/null | \
    python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception:
  # Parse failure / empty output: companion crashed, job id unknown, or output
  # truncated. Keep polling instead of falsely reporting a terminal state.
  print('RUNNING'); sys.exit(0)
s=str((d.get('job') or {}).get('status',''))
print('DONE' if s in ('completed','failed','cancelled') else 'RUNNING')
")
  if [ "$job_phase" = "DONE" ]; then echo "CODEX_DONE"; exit 0; fi

  # Dead-broker probe via reaper (optional — skip gracefully if absent or STATEKEY unknown).
  # Runs AFTER job-status so a completed job whose broker later died is correctly
  # reported as DONE (result fetchable) rather than DEAD (result lost).
  REAPER="${HOME}/.claude/scripts/codex-reap.mjs"
  if [ -f "$REAPER" ] && [ -n "$STATEKEY" ]; then
    # NOTE: python3 -c is used (not `python3 - <<'PY'`) because in bash,
    # `cmd | python3 - <<'HEREDOC'` causes the heredoc to override the pipe
    # as python3's stdin, discarding the piped JSON. -c passes source inline
    # so stdin is the pipe and json.load(sys.stdin) receives the reaper output.
    probe=$(node "$REAPER" --dry-run --json 2>/dev/null | \
      STATEKEY="$STATEKEY" OUR_JOB_ID="$JOB_ID" python3 -c "
import json,sys,os
key=os.environ.get('STATEKEY',''); ourjob=os.environ.get('OUR_JOB_ID','')
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)  # parse failure: emit nothing so probe is skipped; loop continues
dead_brokers=[b for b in d.get('brokers',[]) if os.path.basename(str(b.get('stateDir','')))==key]
dead_jobs=[j for j in d.get('jobs',[]) if str(j.get('id',''))==ourjob]
print('CODEX_DEAD' if (dead_brokers or dead_jobs) else 'CODEX_ALIVE')
")
    if [ "$probe" = "CODEX_DEAD" ]; then echo "CODEX_DEAD"; exit 2; fi
  fi

  if [ "$elapsed" -ge "$MAX" ]; then echo "CODEX_STALL_TIMEOUT"; exit 3; fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done
