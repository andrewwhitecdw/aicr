---
name: aicr-cross-review
agent: claude-code
description: |
  Multi-agent PR review using Claude Code, Codex, and CodeRabbit. Runs
  parallel reviews with integration impact analysis, then iterates
  findings across reviewers until 2-of-3 consensus is reached, with
  every confirmed finding adversarially verified by a fresh agent.
  Use when asked for a thorough cross-review or multi-reviewer analysis.
  Requires both the Codex plugin and the CodeRabbit CLI — see Phase 0.
  Claude Code only — uses Workflow, Agent, and AskUserQuestion tools
  not available in other agents.
user-invocable: true
argument-hint: "[PR-number-or-URL]"
version: 0.2.0
---

# AICR Cross-Review: Multi-Agent PR Review with Consensus

> **Claude Code only.** This skill uses the `Workflow`, `Agent`, and
> `AskUserQuestion` tools which are not available in other agents. If you are
> using Codex, use `$code-review` for a single-reviewer Claude Code review
> instead.

Three independent reviewers (Claude Code, Codex, CodeRabbit) + a targeted
integration impact analysis, cross-reviewed to 2-of-3 consensus, with every
confirmed finding adversarially verified by a fresh agent. Orchestration runs
as a **Workflow** (`scripts/workflow.mjs`) — the user invoking this skill is
the explicit opt-in the Workflow tool requires.

> **Note:** this skill is named `aicr-cross-review` (not `cross-review`) so it
> does not shadow a contributor's global `cross-review` skill. Invoke it as
> `/aicr-cross-review` or `$aicr-cross-review`.

## Input

Raw arguments: `$ARGUMENTS`

If no PR number/URL is provided, detect the current branch's open PR with
`gh pr view --json number,url,title,state`.

## Phase 0: Availability pre-flight — exit if incomplete

Run before anything else.

**Step 0: Verify Claude Code environment.** Before running any shell command,
check whether the `Workflow` tool is available to you. If it is not listed in
your available tools, stop immediately and report:

> This skill requires Claude Code and the `Workflow` tool, which are not
> available in your current environment. Use `$code-review` for a
> single-reviewer review instead.

Do not proceed past this check if `Workflow` is unavailable.

**Step 0.5: Skill-copy trust check (defense-in-depth only).**

> **Trust model — read first.** This step is NOT a security boundary. This
> `SKILL.md` itself lives inside the reviewed repository: if the checkout is
> already on a malicious branch, the attacker has already rewritten these
> instructions — including this guard — before you read them. Instructions
> inside a PR-controlled file cannot protect against that file's own author.
> The real boundary is operational and belongs to the user: **for untrusted
> or fork PRs, invoke this skill from a checkout whose skill copy is trusted**
> (a clean base-branch worktree, or a copy of this skill installed outside
> the repo, e.g. `~/.claude/skills/`), passing the PR number explicitly.
> What this step CAN do is catch the accidental case: a trusted session that
> is about to review a PR which happens to modify the review tooling.

Check the PR's changed-file list (`gh pr view <n> --json files,baseRefName`) before any
helper script runs. If any changed path is under
`.agents/skills/aicr-cross-review/` (or the `.claude/skills/` equivalent),
the scripts you are about to execute are modified by the PR under review.
In that case do NOT execute the checkout's helper scripts. Either:

- resolve `<skill-dir>` from a trusted ref instead — fetch the base branch
  and extract the skill from it (do not depend on Phase 1 having run;
  `baseRefName` comes from the same `gh pr view` call above):
  ```bash
  TRUSTED_SKILL=$(mktemp -d "${TMPDIR:-/tmp}/cr-skill.XXXXXX")
  git -C <repo-path> fetch origin "<baseRefName>"
  git -C <repo-path> archive FETCH_HEAD -- .agents/skills/aicr-cross-review \
    | tar -x -C "$TRUSTED_SKILL"
  # use $TRUSTED_SKILL/.agents/skills/aicr-cross-review as <skill-dir>
  ```
  and remove `$TRUSTED_SKILL` at the end of the review; or
- stop and tell the user the PR modifies the review tooling itself, and ask
  them to run the review from a trusted checkout.

This applies even before the fork coverage confirmation in Phase 1.5 — that
gate only guards `go test` execution, not the orchestration scripts.

Both external reviewers are also required; without either the review cannot
reach the 2-of-3 minimum and produces unverified output of lower value than a
focused single-reviewer review.

```bash
# 1. CodeRabbit CLI — installed AND authenticated
if ! which coderabbit &>/dev/null; then
  echo "CodeRabbit CLI not found (brew install coderabbit)."
  echo "Cross-review requires all three reviewers. Use /code-review for a"
  echo "single-reviewer Claude Code review instead."
  exit 1
fi
# 2. python3 — required for CodeRabbit JSON parsing and codex-watch.sh; check BEFORE
# using python3 below so a missing interpreter surfaces the right error message.
if ! which python3 &>/dev/null; then
  echo "python3 not found. Required for CodeRabbit auth parsing and codex-watch.sh."
  echo "Install python3 (brew install python3) and retry."
  exit 1
fi

# 3. CodeRabbit authenticated — use --agent for machine-readable JSON; v0.7.0 plain
# output contains "Seat: assigned", not "signed in"/"authenticated", so grep is unreliable.
_CR_JSON=$(coderabbit auth status --agent 2>/dev/null || true)
if ! echo "$_CR_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('authenticated') else 1)" 2>/dev/null; then
  echo "CodeRabbit CLI is not authenticated (run: coderabbit auth login)."
  echo "Status: $_CR_JSON"
  echo "Cross-review requires all three reviewers. Use /code-review for a"
  echo "single-reviewer Claude Code review instead."
  exit 1
fi

# 4. Codex companion (installed by the Codex Claude Code plugin)
COMP=$(ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | head -1)
if [ -z "$COMP" ]; then
  echo "Codex companion not found. Install the Codex plugin in Claude Code"
  echo "(Settings → Extensions → Codex) and restart."
  echo "Cross-review requires all three reviewers. Use /code-review for a"
  echo "single-reviewer Claude Code review instead."
  exit 1
fi

echo "Pre-flight OK: python3, CodeRabbit (installed + authenticated), and Codex companion present."
# Note: codex-reap.mjs (~/.claude/scripts/) is used by the Codex watchdog for
# liveness probing. If absent, Codex dispatch degrades gracefully — the workflow
# will return status:"unavailable" for Codex and continue with Claude + CodeRabbit.
```

## Phase 1: Setup — two sequential sub-batches

**Sub-batch A — run first (single message, parallel):** steps 1, 3, 4, 5.

1. `gh pr view <n> --json title,body,baseRefName,headRefName,headRefOid,isCrossRepository,files` — **pin `HEAD_SHA` = `headRefOid`**. Every reviewer reviews this exact commit. Also capture `isCrossRepository` for the coverage gate in Phase 1.5.
3. Build `repoNotes` for the Claude reviewer (never fed to Codex — lean-context rule):
   - Read `.claude/CLAUDE.md` if present (repo coding standards, PR policy, required patterns, anti-patterns). For AICR this is the primary source.
   - Also read `CLAUDE.local.md` if present (personal review overlay — two-question verification protocol, scope discipline, focused-review rules).
   - If neither file exists, set `repoNotes` to an empty string and continue.
   - Distill to 3–6 lines focused on rules most likely to catch defects in the changed paths (error-wrapping rules for Go changes, doc-style rules for doc changes, etc.).
4. If `~/.claude/scripts/codex-reap.mjs` exists, run `node ~/.claude/scripts/codex-reap.mjs` — pre-flight reap of stale Codex state. Liveness-gated (only removes brokers with dead PID/missing socket, jobs with dead PID), so it never disturbs a live concurrent Codex session. If the script is absent, skip this step — the Codex watchdog in Phase 2 handles broker failures gracefully.
5. Worktree hygiene: `git worktree list | wc -l` in the target repo. If >~15, run `git worktree prune` (removes only entries whose directories are already gone — always safe). Do NOT automatically `git worktree remove` existing directories: a clean detached-HEAD worktree may be another session's active review — non-forced removal protects dirty/locked worktrees but not clean ones in use. If pruning is insufficient, list the candidate stale worktrees (detached HEAD, directory mtime older than ~2 hours) and ask the user to confirm before removing any. Rationale for the cap: each worktree adds sandbox deny-list paths; at ~70 the profile exceeded the OS spawn-arg limit and **every sandboxed Bash call failed with `E2BIG`**. Recovery requires a fresh session — prevent it here, but never at the cost of deleting another session's work.

**Sub-batch B — run after sub-batch A completes** (step 2 depends on `HEAD_SHA` from step 1):

2. Fetch and pin the diff to `HEAD_SHA`. `gh pr diff` has no SHA argument, so use `git fetch` to pin the diff to the exact commit. Use `baseRefName` from step 1 — do NOT hardcode `main`; AICR PRs occasionally target other branches. Use a process-unique diff path to prevent concurrent reviews of the same PR from overwriting each other's saved input:
   ```bash
   BASE="<baseRefName>"   # from step 1 — e.g. "main", "release/v0.6", not hardcoded
   PRREF="refs/cr/pr<n>-$$"
   BASEREF="refs/cr/base-$$"
   DIFFPATH=""; KEEP_DIFF=0
   # Register cleanup BEFORE creating anything: an interruption between fetch and
   # the deletions must not leak the process-scoped refs (a later tool call cannot
   # reconstruct this shell's $$). DIFFPATH is preserved only after ownership
   # transfers to the orchestrator (KEEP_DIFF=1 just before the success echoes).
   cleanup() {
     git -C <repo-path> update-ref -d "$PRREF"   2>/dev/null || true
     git -C <repo-path> update-ref -d "$BASEREF" 2>/dev/null || true
     [ "$KEEP_DIFF" -eq 1 ] || rm -f "$DIFFPATH"
   }
   trap cleanup EXIT
   git -C <repo-path> fetch origin \
     "+refs/pull/<n>/head:$PRREF" \
     "+refs/heads/$BASE:$BASEREF"
   FETCHED=$(git -C <repo-path> rev-parse "$PRREF")
   if [ "$FETCHED" != "<HEAD_SHA>" ]; then
     echo "HEAD moved mid-setup (fetched $FETCHED, expected <HEAD_SHA>); restart review"
     exit 1   # trap cleans refs
   fi
   DIFFPATH=$(mktemp "${TMPDIR:-/tmp}/cross-review-pr<n>.XXXXXX")   # must end in X on macOS
   BASE_SHA=$(git -C <repo-path> rev-parse "$BASEREF")
   git -C <repo-path> diff "$BASEREF...$PRREF" > "$DIFFPATH"
   KEEP_DIFF=1   # ownership transfers to the orchestrator below
   echo "DIFFPATH=$DIFFPATH"   # print so the orchestrator can capture it from Bash output
   echo "BASE_SHA=$BASE_SHA"   # print so coverage-check.sh can verify the base is consistent
   ```
   Capture `DIFFPATH` and `BASE_SHA` from the output above — the Bash tool does not persist shell variables between tool calls. Pass `DIFFPATH` as `diffPath` to the Workflow in Phase 2 and to `rm -f` in Phase 5. Pass `BASE_SHA` as the 5th argument to `coverage-check.sh`. (`$TMPDIR` is unset on Linux; `${TMPDIR:-/tmp}` ensures a valid path on both macOS and Linux.)

## Phase 1.5: Classify + extract change list (from the saved diff — no new fetches)

**Classify** the PR as one of: `code-change` | `adr` | `config-change` | `documentation-only`.

**Extract a bounded change list** (constrains integration analysis to verifying specific items, not a repo-wide fishing expedition):
- Exported functions/types/constants added, removed, or modified
- Config keys added or changed (`.yaml`, `.toml`, `.json`)
- Workflow inputs/triggers added or changed
- File/manifest paths renamed or restructured
- Behaviorally significant defaults changed (timeouts, versions, namespaces)

**Go PRs only — launch coverage NOW, in the background** (it depends only on the PR, not the reviews; running it here overlaps the reviews instead of serializing after them).

> **Security:** `coverage-check.sh` executes PR-supplied Go code (`go test`, `make test-coverage`) under your credentials. If the PR is from a fork (`isCrossRepository` = true from step 1), **confirm with the user before launching** — ask "This is a fork PR; running coverage will execute the PR's Go code under your credentials. Proceed?" and skip coverage if they decline. For same-repo PRs, proceed without prompting.

Compute changed Go packages from the PR file list (unique dirs of **all** changed `.go` files, including `_test.go` → `./<dir>/...`). Using all `.go` files ensures test-only PRs are not silently skipped. The exported-function 0%-coverage check in Phase 3 is restricted to non-`_test.go` files.

```bash
bash <skill-dir>/scripts/coverage-check.sh <repo-path> <pr-number> <HEAD_SHA> <baseRefName> <BASE_SHA> ./pkg/x/... ./pkg/y/...
```

Pass `<HEAD_SHA>` so the script verifies the fetched PR head matches. Pass `<baseRefName>` (from step 1) so the script fetches the correct base branch. Pass `<BASE_SHA>` (printed by sub-batch B) so the script verifies the base commit is the same one the diff was computed against — if the base advanced, the script reports a mismatch rather than silently comparing a different baseline. Run with `run_in_background: true`. The script uses throwaway worktrees under `$TMPDIR`, never touches the working copy, and cleans up (worktrees + fetched refs) via trap. Collect its output before writing the report. Skip entirely for non-Go PRs.

`<skill-dir>` is the absolute path to this skill's directory. **If Step 0.5 selected a trusted extracted copy (`$TRUSTED_SKILL/.agents/skills/aicr-cross-review`), that path IS `<skill-dir>` for the rest of the review — here, in Phase 2, and anywhere else scripts run.** Do not fall back to the repo checkout once the trusted copy was chosen; that would route coverage and workflow execution back through PR-controlled scripts. Only when Step 0.5 did not trigger, resolve it as the directory containing this `SKILL.md` file within the repo (e.g. `<repo-root>/.agents/skills/aicr-cross-review`).

## Phase 2: Run the review workflow

```
Workflow({
  scriptPath: "<skill-dir>/scripts/workflow.mjs",
  args: {
    pr: <number>,
    repo: "<owner>/<name>",
    repoPath: "<local checkout path>",
    headSha: "<pinned HEAD_SHA>",
    diffPath: "<saved diff path>",
    prType: "<classification>",
    changeList: ["<item 1>", "<item 2>", ...],
    skillDir: "<skill-dir>",
    repoNotes: "<3-6 line CLAUDE.md digest, optional>",
    model: "<current session model: fable | opus | sonnet | haiku>"
  }
})
```

Pass `changeList` as a real JSON array, not a stringified one.
Resolve `<skill-dir>` as in Phase 1.5.
**Always set `model` to the current session's model family**, mapped to the
Agent-tool enum (`fable` | `opus` | `sonnet` | `haiku`) — you know your own
model from your environment; no detection logic needed. Untyped agents
inherit the session model anyway, but the integration lane's `Explore` agent
type pins its own model in its definition, and a type pin beats session
inheritance unless an explicit `model` override is passed — this arg exists
to keep that lane on the session model too. If the session model does not
map to a supported enum value, omit `model`: every lane still inherits
correctly except `Explore`, which falls back to its pinned default (known
gap). `model` affects only Claude-side agents; the Codex review itself runs
in the Codex CLI and CodeRabbit's in its cloud, so their underlying review
models are unaffected.

**What the workflow does** (details live in `scripts/workflow.mjs` — it is the single source of truth for the consensus mechanics):
- **Review**: Claude Code (via built-in code-review skill + full-file re-verification), Codex (general-purpose agent following CODEX_DISPATCH to background-dispatch and poll the Codex CLI), CodeRabbit (`coderabbit:code-reviewer`, 20-min timebox), and integration analysis (`Explore`, bounded to `changeList`) — all parallel, all returning schema-validated findings.
- **Merge**: dedupe by `path:line:normalized-summary` (lowercase, collapsed whitespace) so two distinct bugs at the same location are tracked separately; multi-source findings tracked but never auto-confirmed; findings citing files absent from the reporter's `filesChecked` get flagged for extra scrutiny.
- **Cross-review** (round 2): each reviewer independently re-reviews first (anti-anchoring), then returns AGREE/DISAGREE/OPEN_QUESTION per candidate with evidence.
- **Consensus** (round 3, contested only): evaluation-only final positions with both sides' reasoning attached.
- **Consensus rule**: confirmed = 2 of 3 reviewers agree with evidence; integration analysis never counts as a reviewer; CodeRabbit adjudicates a Claude/Codex split only with evidence; max 3 rounds total.
- **Verify**: every confirmed finding goes to a fresh adversarial refuter agent that re-reads the full files (REFUTED → dismissed; UNVERIFIABLE → open question).
- **Minimum-2 rule**: enforced in-script; if fewer than 2 reviewers (or neither Claude nor Codex) are available, it returns `status: "insufficient-reviewers"` with raw unverified findings — report them as such, clearly marked no-consensus.

**Operational notes:**
- The workflow runs in the background — wait for its completion notification; don't poll it.
- If the run dies or is interrupted, **resume instead of restarting**: `Workflow({scriptPath: ..., resumeFromRunId: "<wf_...>"})` — completed reviewers replay from cache; only unfinished stages re-run. This is the recovery path for Codex broker crashes: nothing else is lost.
- Empty/odd result → Read `<transcriptDir>/journal.jsonl` before diagnosing; do not assume cached results are non-empty.
- Codex lean-context rules and CODEX_DISPATCH protocol are embedded in the workflow script prompts. The Codex reviewer runs as a `general-purpose` agent (not `codex:codex-rescue` — that agent prefers background execution and may return a job handle instead of structured findings). `scripts/codex-watch.sh` is the watchdog used by the CODEX_DISPATCH poll step.
- CodeRabbit slow runs: check the newest file in `~/.coderabbit/logs/` (429/queue/retry = cloud-side; nothing to fix locally). Also verify `which -a coderabbit` resolves to the brew-managed binary — a stale `~/.local/bin` copy can shadow it.

## Phase 3: Coverage results (Go PRs only)

Map the script's explicit output states:

| Script output | Action |
|---|---|
| `FLOOR: PASS` | No floor finding. |
| `FLOOR: FAIL` | **critical** finding — PR is below `.settings.yaml` `quality.coverage_threshold` (threshold-only check, tests not rerun). If the message notes "base baseline unavailable", the PR verdict still stands but flag the base test failure as context. |
| `FLOOR: TEST FAIL` | **major** finding — `make test` fails in the PR worktree but passes on base; test regression in the PR, not a coverage threshold issue. Fix tests before interpreting coverage results. |
| `FLOOR: PRE-EXISTING TEST FAIL` | Coverage unavailable; note as context. `make test` fails on the base too — environmental or pre-existing, not a PR regression. Do not file as a PR finding. |
| `FLOOR: PRE-EXISTING FAIL` | Coverage unavailable; note as context. The base also fails the threshold, so this is not a PR regression. Do not file as critical. Script exits nonzero — this is expected. |
| `COVERAGE INVALID: fetched PR head … does not match` | PR head moved after Phase 1. Mark all coverage as unavailable and restart the full review against the new SHA. |
| `COVERAGE INVALID: fetched base … does not match` | Base advanced after Phase 1 diff was generated. Coverage invalid; restart or re-run coverage with the new base SHA. |
| `COVERAGE INVALID: a go test run failed` | Tests failed; delta unreliable. Triage whether failure reproduces on the base branch before treating as a PR finding. |

Per-function and per-package delta (from the script's non-floor output):
- **major** if any new exported function/method shows 0% in the per-function listing
- **minor** if any package's statement coverage decreased by > 0.5% (compare PR vs BASE per-package totals)

## Phase 4: Consensus report

Build from the workflow's return value + coverage results:

```markdown
## Cross-Review Summary for PR #<number>

**Reviewers:** Claude Code, Codex, CodeRabbit + Integration Analysis
**Head commit:** <sha> | **Rounds:** <N> | **Consensus reached:** Yes/No
<reviewer availability notes: e.g. "Codex needed a reap+retry", "CodeRabbit late — vote missing">

### Confirmed Issues (met consensus rule; survived adversarial verification)

| # | File | Line | Severity | Description | Confirmed By |
|---|------|------|----------|-------------|-----------|

### Integration Findings (cross-cutting impact)

| # | Changed File | Consumer File | Severity | Description | Confirmed By |
|---|-------------|---------------|----------|-------------|-----------|

### Contested Issues (no consensus after max rounds)

| # | File | Line | Severity | Description | For | Against | Reasoning |
|---|------|------|----------|-------------|-----|---------|-----------|

### Dismissed Findings

<finding, who flagged it, why dismissed (incl. "failed adversarial verification: ...")>

### Open Questions

<unverifiable findings + reviewers' open questions>

### Test Coverage (Go PRs only)

| Package | Main | PR | Delta | Status |
|---------|------|-----|-------|--------|

<omit for non-Go PRs>

### Positive Observations

<noteworthy good patterns>
```

## Phase 5: Output

**Default: do NOT post.** Present the full report in chat and stop. Do not post anything to the PR without an explicit request from the user.

**When explicitly asked to post:**
- `gh pr comment <number> --body "..."` for the summary; `gh api repos/{owner}/{repo}/pulls/{number}/reviews` for inline comments
- Post **issues only**: Confirmed Issues (without the "Confirmed By" column) + confirmed Integration Findings + Contested Issues + Open Questions
- **No reviewer-agent attribution and no severity-label prefixes** in posted content. State each finding and its evidence plainly.
- Never post Dismissed Findings or Positive Observations.

## Rules

- Never post to the PR without explicit user request.
- The consensus rule, minimum-2 rule, and max-3-rounds cap are enforced inside `scripts/workflow.mjs` — keep the script and this doc in sync if either changes.
- Confirmed integration findings identifying broken consumers are escalated to at least **medium** severity (done in-script).
- Severity scale: critical (must fix) > major (should fix) > medium > minor (consider fixing).
- Keep the report concise — actionable findings, not noise.
- Never set `dangerouslyDisableSandbox` for reviewer/companion/reaper commands — they run fine sandboxed.
- **Clean up all temporary artifacts before finishing.** Delete `DIFFPATH` (the saved diff created by Phase 1 sub-batch B via `mktemp`): `rm -f "$DIFFPATH"`. If Phase 1 sub-batch B fails after fetching refs but before deleting them, clean up the scoped refs explicitly: `git -C <repo-path> update-ref -d "$PRREF"` and `git -C <repo-path> update-ref -d "$BASEREF"`.
- **Remove every worktree this review created before finishing.** Track the specific worktree paths created during this review (the coverage script creates paths under `$TMPDIR/cr-cov.*`; any explicit verification worktrees add paths too). At the end, confirm each of those specific paths is absent from `git worktree list`. Do NOT compare total counts — the global total may legitimately increase or decrease due to concurrent work in other sessions, so a count mismatch is not a reliable signal. Use `git worktree list | wc -l` only diagnostically. The coverage script cleans its own worktrees via trap; verify anyway. Leaked worktrees accumulate and eventually break the sandbox for all future sessions (E2BIG — Phase 1 step 5).
