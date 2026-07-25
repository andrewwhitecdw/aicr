// Claude Code Workflow script — runs in a custom async execution context where
// top-level `return` statements are valid (they return the workflow result).
// Standard JS linters (Biome, ESLint) may flag these as parse errors; that is
// expected and does not affect runtime behaviour.
export const meta = {
  name: 'cross-review',
  description: 'Multi-reviewer PR review (Claude Code, Codex, CodeRabbit) with integration impact analysis, consensus rounds, and adversarial verification of confirmed findings',
  whenToUse: 'Invoked by the cross-review skill after Phase 1 setup; args carry the pinned SHA, saved diff path, PR type, and bounded change list.',
  phases: [
    { title: 'Review', detail: '3 reviewers + integration impact analysis, parallel' },
    { title: 'Cross-review', detail: 'independent re-review, then AGREE/DISAGREE on every candidate' },
    { title: 'Consensus', detail: 'final positions on contested findings' },
    { title: 'Verify', detail: 'one adversarial refuter per confirmed finding' },
  ],
}

// ---------- args ----------
// pr: number|string, repo: "owner/name", repoPath: local checkout,
// headSha: pinned head commit, diffPath: pre-fetched diff file,
// prType: code-change|adr|config-change|documentation-only,
// changeList: string[] bounded change list for integration analysis,
// skillDir: this skill's directory (for scripts/), repoNotes: optional short CLAUDE.md digest
// Tolerate args arriving as a JSON string (observed 2026-07-21: the harness
// delivered `args` stringified even when the tool call passed a real object).
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const { pr, repo, repoPath, headSha, diffPath, prType, changeList, skillDir, repoNotes, model } = parsedArgs
for (const [k, v] of Object.entries({ pr, repo, repoPath, headSha, diffPath, prType, skillDir })) {
  if (!v) throw new Error(`missing required arg: ${k}`)
}
const changes = Array.isArray(changeList) ? changeList : []
// Model override for the Claude-side agents (claude reviewer, integration,
// cross-review rounds, verifiers). This exists specifically so TYPED agents
// match the session model: untyped/general-purpose agents inherit it anyway,
// but the integration lane's Explore agent type pins its own model in its
// definition, and a type pin beats session inheritance unless an explicit
// opts.model is passed. SKILL.md Phase 2 always sets this to the session's
// model family. Omitted → all lanes inherit except Explore (pinned default).
// The Codex review itself runs in the Codex CLI and CodeRabbit's in its
// cloud — this override affects only their Claude wrapper agents.
const MODEL_OPT = model ? { model } : {}

// ---------- schemas ----------
const FINDING_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'path', 'line', 'summary', 'evidence', 'impact'],
  properties: {
    severity: { type: 'string', enum: ['critical', 'major', 'medium', 'minor'] },
    path: { type: 'string', description: 'repo-relative file path' },
    line: { type: 'integer' },
    summary: { type: 'string' },
    evidence: { type: 'string', description: 'what in code proves the issue (path:line + fact)' },
    impact: { type: 'string', description: 'who breaks / what regresses' },
    consumerPath: { type: 'string', description: 'integration findings only: consumer-side file' },
    consumerLine: { type: 'integer' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings', 'openQuestions', 'filesChecked'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unavailable'] },
    statusNote: { type: 'string', description: 'when unavailable: what failed (broker dead, cloud timeout, CLI missing)' },
    findings: { type: 'array', items: FINDING_ITEM },
    openQuestions: { type: 'array', items: { type: 'string' } },
    residualRisk: { type: 'array', items: { type: 'string' } },
    positives: { type: 'array', items: { type: 'string' } },
    filesChecked: { type: 'array', items: { type: 'string' }, description: 'files actually read (full or targeted excerpts), not just the diff' },
  },
}

const EVAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'evaluations', 'newFindings'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unavailable'] },
    statusNote: { type: 'string' },
    evaluations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'reason'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['AGREE', 'DISAGREE', 'OPEN_QUESTION'] },
          evidence: { type: 'string', description: 'path:line — REQUIRED for AGREE and DISAGREE' },
          reason: { type: 'string' },
        },
      },
    },
    newFindings: { type: 'array', items: FINDING_ITEM },
  },
}

const REFUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNVERIFIABLE'] },
    evidence: { type: 'string', description: 'path:line you independently checked' },
    reason: { type: 'string' },
  },
}

// ---------- shared prompt fragments ----------
// codex uses general-purpose (not codex:codex-rescue) so it has full multi-step Bash access
// for the CODEX_DISPATCH protocol; codex-rescue prefers background execution and may return
// a job handle instead of structured findings.
const AGENT_TYPE = { claude: 'general-purpose', codex: 'general-purpose', coderabbit: 'coderabbit:code-reviewer' }

const header = `PR #${pr} on ${repo}, head commit ${headSha} (review THIS commit).
Saved diff: ${diffPath} — read the diff from this file; do NOT re-fetch it (the branch may move mid-review; every reviewer must see the same code).
Repo working copy: ${repoPath}.`

const OUTPUT_RULES = `
Reporting rules:
- Report only findings you verified in code. Do not report preferences or speculative concerns as findings.
- If something might be wrong but you cannot verify it, put it in openQuestions, not findings.
- Do not fabricate evidence from external sources. Do not cite upstream charts, external APIs, or third-party docs unless you actually fetched and read them in this session; otherwise it is an open question.
- "No findings" is a valid and valuable outcome. Do not reach for speculative findings to avoid returning empty-handed.
- Every finding needs exact path + line + evidence + impact.
- List every file you actually read in filesChecked.`

const CODEX_LEAN = `
Context rules (IMPORTANT — the Codex broker reproducibly crashes mid-generation on large accumulated context; verified on PR #1196):
- Work primarily from the saved diff (cat ${diffPath}). Read targeted excerpts at the pinned commit:
    git -C ${repoPath} show ${headSha}:<path> | sed -n '<start>,<end>p'
- For consumer/caller searches, use git grep against the pinned commit tree — NOT bare rg, which searches
  the mutable working copy and may silently include or miss files on the wrong branch:
    git -C ${repoPath} grep -n <pattern> ${headSha} -- <glob>
- Do NOT read CLAUDE.md.
- Before reporting a missing path/key/field/API, confirm absence at the pinned commit with a targeted check, not a full-file read.`

const CODEX_DISPATCH = `
Codex dispatch protocol (mandatory):
1. Dispatch the review as a BACKGROUND Codex task — pass --background to codex-companion task so it returns a job id immediately. NEVER run foreground: a foreground call hangs forever if the broker dies mid-turn.
   comp=$(ls -t ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | head -1)
2. Poll with the watchdog script (blocks internally, prints one state token):
   bash ${skillDir}/scripts/codex-watch.sh <job-id> 900 30
   - CODEX_DONE: fetch the stored review output via node "$comp" result <job-id> --json (NOT status — status returns only a job summary without the payload). If the job's status is failed or cancelled, treat Codex as unavailable (statusNote with the status) rather than parsing the result.
   - CODEX_DEAD: broker/worker is dead; the job can NEVER complete. Recover: node "$comp" cancel <job-id> (best-effort); node ~/.claude/scripts/codex-reap.mjs; sanity-probe with node "$comp" task "Reply with exactly COMPANION_OK" (expect COMPANION_OK within 30s); then re-dispatch the review ONCE and watch again.
   - CODEX_STALL_TIMEOUT: the LLM may legitimately take 10-15 min; this token already means the 15-min cap passed. Treat as failed.
3. If Codex still fails after one reap+retry, return status:"unavailable" with a statusNote — do not block.
Shell note: never name a shell variable "status" (readonly in zsh; the assignment silently fails). Never bypass the sandbox — companion and reaper run fine sandboxed.`


const CODEX_FOCUS = {
  'code-change': `Review for bugs, regressions, broken consumers, security issues, and instruction/config compliance.

Behavioral correctness (review the changed code's internal logic, not just its callers):
- For each materially changed function or new control-flow branch, trace concrete inputs through happy path, error path, and edge cases; check actual behavior matches comments, tests, and the PR description.
- For fallback/reset/retry/exclusion logic, verify the scope precisely: it must affect only the intended state and not discard unrelated data.
- For metadata/diagnostic output (warnings, errors, logs, status fields), verify names/paths/IDs derive from the real triggering context, not placeholders or stale variables.
- For loops or multi-branch state assembly, check accumulated maps/slices/sets stay consistent across all branches, including early returns and partial-failure paths.

Consumer search:
- Search for consumers of changed exported APIs, config keys, flags, env vars, image names, workflow inputs, file paths, and cross-file behavior changes.
- Check CI/workflows (.github/, .gitlab-ci.yml, Makefile, Helm charts, deployment scripts), tests, fixtures, scripts, and docs that depend on old behavior.
- Skip purely local/private helper callers unless the behavior change escapes the file.`,
  'adr': `This PR is an ADR/design doc. Read the full changed document (prose, usually one file — fine to read in full). Read only the specific prior ADRs/implementation sections a given claim depends on.

Review for concrete design gaps:
- Missing required contracts for correctness
- Unacknowledged behavior changes vs the current system
- Missing operational semantics (failure, rollback, migration, version requirements)
- Claims that do not connect to actual codebase concepts or prior ADRs
Only report a finding if you can point to the exact doc line plus supporting code/doc evidence. No generic style preferences.`,
  'config-change': `Review for correctness, downstream consumers, and environment impact.
- For each changed config value, search the repo for all consumers that read or depend on it.
- Check CI workflows (.github/, .gitlab-ci.yml, Makefile, Helm charts, deployment scripts), application code, and tests referencing the changed keys.
- Skip purely local references unless the change crosses boundaries.`,
  'documentation-only': `Review the changed docs for:
- Factual accuracy: do the docs match what the code actually does?
- Stale references: do linked files, functions, flags, and config keys still exist?
- Missing context: omitted caveats, prerequisites, version requirements.
Read only targeted excerpts of the code/config the docs describe. No style/formatting preferences.`,
}

// ---------- Round 1 prompts ----------
function claudeReviewPrompt() {
  return `You are the Claude Code reviewer in a multi-reviewer cross-review.
${header}
${repoNotes ? `Repo conventions relevant to this review:\n${repoNotes}\n` : ''}
First try running Skill("code-review:code-review", "${pr}") — do NOT post any comment to GitHub. If the skill ends by attempting to post (e.g. via gh pr comment), skip that step; only return findings to this prompt. If the skill is unavailable or refuses (e.g. draft PR), perform your own thorough review of the saved diff instead.

Then re-verify before returning: for each finding, read and search at the pinned commit (not the diff and not the working copy which may be on a different branch):
  read:   git -C ${repoPath} show ${headSha}:<path>
  search: git -C ${repoPath} grep -n <pattern> ${headSha} -- <glob>
Only return findings that survive this verification. Before reporting a missing path/config key/field/API, read the full existing file at the pinned commit to confirm it is actually absent.
${OUTPUT_RULES}`
}

function codexReviewPrompt() {
  return `You drive the Codex reviewer in a multi-reviewer cross-review.
${header}
${CODEX_DISPATCH}

Compose a LEAN Codex task prompt containing the saved-diff path, these review instructions, and the reporting rules:
${CODEX_FOCUS[prType] || CODEX_FOCUS['code-change']}
${CODEX_LEAN}
${OUTPUT_RULES}
Translate Codex's raw output into the structured result yourself. If Codex is unavailable after one reap+retry, return status:"unavailable" with statusNote.`
}

function coderabbitReviewPrompt() {
  return `You are the CodeRabbit reviewer in a multi-reviewer cross-review.
${header}
Perform a thorough code review of the full PR-branch diff (do NOT use "-t uncommitted" — cross-review needs the full PR diff). Do NOT post anything to GitHub.
For each changed function, constant, config value, or behavioral change, search for callers and consumers beyond the diff using the pinned commit tree (NOT the mutable working copy, which may be on a different branch):
  search: git -C ${repoPath} grep -n <pattern> ${headSha} -- <glob>
  read:   git -C ${repoPath} show ${headSha}:<path>
Check CI workflows (.github/, .gitlab-ci.yml, Makefile), test fixtures, config files, and other packages. Report any consumers that would break.
Before reporting a missing path/key/field/API, read the full existing file at the pinned commit to confirm it is actually absent.

Timebox: the coderabbit CLI streams to CodeRabbit's cloud and blocks until the cloud review completes; all latency is service-side. If it has not completed after ~20 minutes, abandon it, check the newest file in ~/.coderabbit/logs/ for 429/queue/retry lines (to attribute cloud queueing vs local problems), and return status:"unavailable" with what you saw in statusNote.
${OUTPUT_RULES}`
}

function integrationPrompt() {
  const list = changes.length ? changes.map((c) => `- ${c}`).join('\n') : '- (none extracted — return an empty findings list)'
  return `Integration impact analysis for a cross-review. This catches issues invisible when reviewing the diff in isolation.
${header}
Verify ONLY these specific changed items. Say nothing for an item when nothing real is found. Do NOT expand the search beyond this list:
${list}

For each item:
1. Search the repo for callers, consumers, and references — beyond the files in the diff.
2. Check CI/CD (.github/workflows/, .github/actions/, .gitlab-ci.yml, Makefile, Helm charts, Tiltfile, deployment scripts), test fixtures and integration tests (testdata/, tests/), docs, and config files.
3. Distinguish "definitely breaks" (consumer depends on exact old behavior) from "might break" (depends on runtime conditions) in the impact field.
4. Report a finding ONLY with both sides as evidence: path/line = changed side, consumerPath/consumerLine = consumer side.

Rules:
- Read and search at the pinned commit — NOT the mutable working copy (which may be on a different branch):
    read:   git -C ${repoPath} show ${headSha}:<path>
    search: git -C ${repoPath} grep -n <pattern> ${headSha} -- <glob>
  The diff shows changes; the pinned tree shows current state.
- Do not cite upstream charts, external APIs, or third-party docs unless you actually fetched them; unverifiable external claims go in openQuestions.
- "No integration impact" is a valid outcome — an empty findings list is fine. Do not invent impacts to justify the analysis.
${OUTPUT_RULES}`
}

// ---------- Cross-review prompts ----------
function positionsBlock(c, participants, evals) {
  return participants
    .map((k) => {
      // Check latest evaluation first — a reporter may have revised their position
      // in cross-review (e.g. submitted DISAGREE after finding their own finding wrong).
      const e = evals[k][c.id]
      if (e) return `${k}=${e.verdict}${e.reason ? ` — ${e.reason}` : ''}${e.evidence ? ` [${e.evidence}]` : ''}`
      if (c.sources.includes(k)) return `${k}=AGREE (original reporter)`
      return `${k}=no position yet`
    })
    .join('; ')
}

function findingBlock(c, withPositions, participants, evals) {
  const src = c.sources.map((s) => (s === 'integration' ? '[Integration]' : s)).join(', ')
  return [
    `${c.id} [${c.severity}] ${c.path}:${c.line} — ${c.summary}`,
    `  Evidence: ${c.evidence}`,
    `  Impact: ${c.impact}`,
    c.consumerPath ? `  Consumer: ${c.consumerPath}:${c.consumerLine || '?'}` : null,
    `  Sources: ${src}`,
    c.flags.length ? `  Flags: ${c.flags.join('; ')}` : null,
    withPositions ? `  Positions so far: ${positionsBlock(c, participants, evals)}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

function crossPrompt(k, roundNum, items, participants, evals) {
  const list = items.map((c) => findingBlock(c, roundNum >= 3, participants, evals)).join('\n\n')
  const roundIntro =
    roundNum === 2
      ? `First, INDEPENDENTLY re-review the PR before reading the candidate list — cross-reference the wider repo, not just the diff${prType === 'adr' ? ', including existing architecture, prior ADRs, and codebase patterns' : ''}. Put anything you missed in Round 1 into newFindings. THEN evaluate every candidate below.`
      : `FINAL round. These findings are contested — each carries the positions and reasoning so far. Take a final position on each: AGREE or DISAGREE with evidence, or OPEN_QUESTION if genuinely unverifiable. Return newFindings as an empty array.`
  const perReviewer =
    k === 'codex'
      ? `${CODEX_DISPATCH}\n${CODEX_LEAN}\nFor each candidate, have Codex read just the cited lines at the pinned commit (git -C ${repoPath} show ${headSha}:<path> | sed -n) before returning a verdict.${prType === 'code-change' && roundNum === 2 ? '\nDuring the independent re-review apply the behavioral correctness checks: trace inputs through happy/error/edge paths; verify the scope of fallback/reset/retry logic; verify diagnostic metadata derives from real context; check multi-branch state consistency.' : ''}`
      : k === 'coderabbit'
        ? `Search and read at the pinned commit (not the mutable working copy): git -C ${repoPath} grep -n <pattern> ${headSha} -- <glob> and git -C ${repoPath} show ${headSha}:<path>. Timebox: if the CodeRabbit cloud review has not completed within ~20 minutes, evaluate the candidates from your own direct reading of the pinned commit instead and say so in statusNote.`
        : `Re-read the saved diff at ${diffPath} and search/read the repo at the pinned commit (not the mutable working copy, which may be on a different branch):
  search: git -C ${repoPath} grep -n <pattern> ${headSha} -- <glob>
  read:   git -C ${repoPath} show ${headSha}:<path>
For "missing X" candidates, read the full existing file at the pinned commit to confirm absence.`
  return `You are the ${k} reviewer in cross-review round ${roundNum}.
${header}

${roundIntro}

${perReviewer}

Candidate findings:
${list}

Evaluation rules:
- Return exactly one evaluation per candidate id: AGREE / DISAGREE / OPEN_QUESTION.
- AGREE only if you directly checked the cited file(s); put the checked path:line in evidence.
- DISAGREE must include counter-evidence (path:line) in evidence.
- [Integration] findings are the LEAST reliable source and get your deepest scrutiny: for "missing path/key" claims verify absence yourself; for upstream/dependency assumptions fetch the source or return OPEN_QUESTION; an unverifiable integration claim defaults to OPEN_QUESTION, never AGREE.
- Multi-source findings are NOT automatically true — multiple reviewers can converge on the same wrong surface-level claim without checking the full file. Verify the evidence yourself.`
}

// ---------- Phase: Review (barrier justified: cross-review needs the merged candidate list) ----------
log(`Round 1: launching Claude Code, Codex, CodeRabbit + integration analysis for PR #${pr} (${prType})`)
const [claudeR, codexR, rabbitR, integR] = await parallel([
  () => agent(claudeReviewPrompt(), { label: 'review:claude', phase: 'Review', schema: FINDINGS_SCHEMA, agentType: AGENT_TYPE.claude, ...MODEL_OPT }),
  () => agent(codexReviewPrompt(), { label: 'review:codex', phase: 'Review', schema: FINDINGS_SCHEMA, agentType: AGENT_TYPE.codex, ...MODEL_OPT }),
  () => agent(coderabbitReviewPrompt(), { label: 'review:coderabbit', phase: 'Review', schema: FINDINGS_SCHEMA, agentType: AGENT_TYPE.coderabbit, ...MODEL_OPT }),
  () => agent(integrationPrompt(), { label: 'review:integration', phase: 'Review', schema: FINDINGS_SCHEMA, agentType: 'Explore', ...MODEL_OPT }),
])

const ok = (r) => (r && r.status === 'ok' ? r : null)
const R = { claude: ok(claudeR), codex: ok(codexR), coderabbit: ok(rabbitR) }
const integ = ok(integR)
const statusOf = (r) => (r ? (r.status === 'ok' ? 'ok' : `unavailable${r.statusNote ? ` — ${r.statusNote}` : ''}`) : 'no result (skipped or died)')
const reviewerStatus = {
  claude: statusOf(claudeR),
  codex: statusOf(codexR),
  coderabbit: statusOf(rabbitR),
  integration: statusOf(integR),
}
const participants = ['claude', 'codex', 'coderabbit'].filter((k) => R[k])
log(`Round 1 done: participants=[${participants.join(', ')}], integration=${integ ? 'ok' : 'unavailable'}`)

const openQuestions = []
const residualRisk = []
const positives = []
for (const [k, r] of Object.entries({ ...R, integration: integ })) {
  if (!r) continue
  for (const q of r.openQuestions || []) openQuestions.push(`[${k}] ${q}`)
  for (const q of r.residualRisk || []) residualRisk.push(`[${k}] ${q}`)
  for (const p of r.positives || []) positives.push(`[${k}] ${p}`)
}

// Minimum-2 rule: >=2 reviewers, at least one of Claude Code / Codex.
if (participants.length < 2 || (!R.claude && !R.codex)) {
  return {
    status: 'insufficient-reviewers',
    note: 'Minimum-2 rule violated (need >=2 of Claude/Codex/CodeRabbit, incl. Claude Code or Codex). No consensus possible — raw findings returned UNVERIFIED.',
    pr, headSha, prType, reviewerStatus,
    rawFindings: [claudeR, codexR, rabbitR, integR].filter(Boolean).flatMap((r) => r.findings || []),
    openQuestions, residualRisk, positives,
  }
}

// ---------- Merge & dedupe into candidates ----------
const candidates = []
const byKey = new Map()
// Normalize summary for dedup: lowercase + collapse whitespace.
// Dedup key includes summary so two distinct bugs at the same path:line are
// tracked as separate candidates rather than merged into one.
const normSummary = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
function addCandidate(f, source) {
  const key = `${f.path}:${f.line}:${normSummary(f.summary)}`
  const existing = byKey.get(key)
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source)
    return existing
  }
  const c = { ...f, id: `F${candidates.length + 1}`, sources: [source], flags: [] }
  byKey.set(key, c)
  candidates.push(c)
  return c
}
for (const k of participants) {
  const r = R[k]
  const checked = r.filesChecked || []
  for (const f of r.findings || []) {
    const c = addCandidate(f, k)
    // "Files checked" as an actual control: unlisted file => flag for extra scrutiny downstream.
    if (!checked.some((p) => p.endsWith(f.path) || f.path.endsWith(p))) {
      c.flags.push(`${k} reported this file without listing it in filesChecked — scrutinize`)
    }
  }
}
if (integ) for (const f of integ.findings || []) addCandidate(f, 'integration')
log(`Merged: ${candidates.length} unique candidate finding(s)`)

// ---------- Consensus rounds (max 3 total incl. Round 1) ----------
const evals = { claude: {}, codex: {}, coderabbit: {} } // reviewer -> id -> latest evaluation
const resolution = {} // id -> 'confirmed' | 'dismissed' | 'open'
const dismissReason = {}

// Check latest cross-review evaluation FIRST so a reporter who later submits
// DISAGREE (found their own finding wrong) is counted correctly, not locked
// into AGREE merely because they were the original source.
const verdictFor = (k, c) => {
  if (evals[k][c.id]) return evals[k][c.id].verdict
  if (c.sources.includes(k)) return 'AGREE'
  return 'NONE'
}
// Trim before returning so callers treat whitespace-only strings as absent.
// A single space in the evidence field is not a real code citation.
const evidenceFor = (k, c) => {
  const raw = evals[k][c.id] ? (evals[k][c.id].evidence || '') : c.sources.includes(k) ? (c.evidence || '') : ''
  return raw.trim()
}

// Single consensus rule (mirrors SKILL.md): confirmed = 2+ reviewer AGREEs (integration never counts);
// CodeRabbit adjudicates a Claude/Codex split only with evidence; 2+ DISAGREEs or zero support = dismissed.
// Evidence is required for AGREE and DISAGREE votes — an evidence-free vote is not counted. This
// prevents a reviewer from accidentally tipping consensus by returning a verdict without checking code.
function tally(c) {
  const agrees = participants.filter((k) => verdictFor(k, c) === 'AGREE' && evidenceFor(k, c))
  const disagrees = participants.filter((k) => verdictFor(k, c) === 'DISAGREE' && evidenceFor(k, c))
  if (agrees.length >= 2) return 'confirmed'
  if (disagrees.length >= 2) return 'dismissed'
  if (R.claude && R.codex && R.coderabbit) {
    const cv = verdictFor('claude', c); const ce = evidenceFor('claude', c)
    const xv = verdictFor('codex', c);  const xe = evidenceFor('codex', c)
    // Both sides must have evidence before invoking CodeRabbit arbitration — an
    // evidence-free AGREE/DISAGREE from either side is not a grounded split.
    if (ce && xe && ((cv === 'AGREE' && xv === 'DISAGREE') || (cv === 'DISAGREE' && xv === 'AGREE'))) {
      const rv = verdictFor('coderabbit', c)
      if (rv === 'AGREE' && evidenceFor('coderabbit', c)) return 'confirmed'
      if (rv === 'DISAGREE' && evidenceFor('coderabbit', c)) return 'dismissed'
    }
  }
  if (agrees.length === 0 && disagrees.length > 0) return 'dismissed'
  return 'contested'
}

let round = 1
let pending = candidates.map((c) => c.id)

while (pending.length && round < 3) {
  round++
  const phaseName = round === 2 ? 'Cross-review' : 'Consensus'
  const items = candidates.filter((c) => pending.includes(c.id))
  log(`Round ${round}: ${items.length} candidate(s) to ${round === 2 ? 'cross-review' : 'adjudicate'}`)
  const results = await parallel(
    participants.map((k) => () =>
      agent(crossPrompt(k, round, items, participants, evals), {
        label: `cross:${k}:r${round}`,
        phase: phaseName,
        schema: EVAL_SCHEMA,
        agentType: AGENT_TYPE[k],
        ...MODEL_OPT,
      })),
  )
  participants.forEach((k, i) => {
    const res = ok(results[i])
    if (!res) {
      log(`Round ${round}: ${k} unavailable this round — keeping its prior positions`)
      return
    }
    for (const e of res.evaluations || []) {
      const c = candidates.find((x) => x.id === e.id)
      if (!c) continue
      const hasEvidence = (e.evidence || '').trim().length > 0
      // An evidence-free AGREE or DISAGREE carries no verifiable claim and must
      // not update evals — storing it would void the reporter's original evidenced
      // source position (via the verdictFor/evidenceFor fallback) on a retraction
      // that was never checked. OPEN_QUESTION is always stored; it is a question
      // not a grounded assertion, so it does not require code evidence.
      if ((e.verdict === 'AGREE' || e.verdict === 'DISAGREE') && !hasEvidence) {
        log(`Round ${round}: dropped evidence-free ${e.verdict} from ${k} on ${e.id} — path:line evidence is required for AGREE/DISAGREE; this vote was not counted`)
        continue
      }
      evals[k][e.id] = e
    }
    if (round === 2) {
      for (const f of res.newFindings || []) {
        const c = addCandidate(f, k)
        if (!pending.includes(c.id) && !resolution[c.id]) pending.push(c.id)
      }
    }
  })
  const still = []
  for (const id of pending) {
    const c = candidates.find((x) => x.id === id)
    const t = tally(c)
    if (t === 'confirmed' || t === 'dismissed') {
      resolution[id] = t
      if (t === 'dismissed') {
        dismissReason[id] =
          participants
            .filter((k) => verdictFor(k, c) === 'DISAGREE')
            .map((k) => `${k}: ${(evals[k][id] && (evals[k][id].reason || evals[k][id].evidence)) || 'disagreed'}`)
            .join(' | ') || 'no reviewer support'
      }
    } else {
      still.push(id)
    }
  }
  pending = still
  const counts = Object.values(resolution)
  log(`Round ${round} tally: confirmed=${counts.filter((v) => v === 'confirmed').length}, dismissed=${counts.filter((v) => v === 'dismissed').length}, contested=${pending.length}`)
}

// Remaining pending after max rounds: no position at all -> open question; otherwise contested.
const contestedIds = []
for (const id of pending) {
  const c = candidates.find((x) => x.id === id)
  const agrees = participants.filter((k) => verdictFor(k, c) === 'AGREE').length
  const disagrees = participants.filter((k) => verdictFor(k, c) === 'DISAGREE').length
  if (agrees === 0 && disagrees === 0) {
    resolution[id] = 'open'
    openQuestions.push(`[unadjudicated] ${c.path}:${c.line} — ${c.summary} (no reviewer took a position within max rounds)`)
  } else {
    contestedIds.push(id)
  }
}

// ---------- Phase: Verify (adversarial refuter per confirmed finding, fresh context each) ----------
const confirmedIds = candidates.filter((c) => resolution[c.id] === 'confirmed').map((c) => c.id)
log(`Verification: adversarially re-checking ${confirmedIds.length} confirmed finding(s)`)

function refutePrompt(c) {
  return `Adversarial verification of a code-review finding that reached reviewer consensus. Your job is to try to REFUTE it — default to skepticism.
${header}
Finding ${c.id} [${c.severity}] ${c.path}:${c.line} — ${c.summary}
Evidence claimed: ${c.evidence}
Impact claimed: ${c.impact}
${c.consumerPath ? `Claimed broken consumer: ${c.consumerPath}:${c.consumerLine || '?'}` : ''}${c.flags.length ? `\nFlags: ${c.flags.join('; ')}` : ''}

Method:
- Read the FULL cited file(s) at the pinned commit — not just the diff and not the working copy (which may be on a different branch): git -C ${repoPath} show ${headSha}:<path>. The diff shows what changed; the full file shows current state.
- For "missing X" claims, confirm X is actually absent from the existing file.
- For consumer-breakage claims, trace the actual dependency from consumer to changed code.
- For claims about upstream/external systems, fetch the cited source; if you cannot, return UNVERIFIABLE.
Return CONFIRMED only if you independently reproduced the evidence (cite what you checked). REFUTED requires counter-evidence (path:line).`
}

const verifierResults = await parallel(
  confirmedIds.map((id) => () => {
    const c = candidates.find((x) => x.id === id)
    return agent(refutePrompt(c), { label: `verify:${id}`, phase: 'Verify', schema: REFUTE_SCHEMA, ...MODEL_OPT })
  }),
)
confirmedIds.forEach((id, i) => {
  const v = verifierResults[i]
  const c = candidates.find((x) => x.id === id)
  if (!v) {
    // A missing verifier result (agent timeout/failure) means the finding was never
    // independently checked. Report it as an open question rather than leaving it in
    // "confirmed" — "survived adversarial verification" must be literally true.
    resolution[id] = 'open'
    openQuestions.push(`[verification] ${c.path}:${c.line} — ${c.summary}: verifier returned no result (agent timeout or failure) — consensus reached but unverified; treat as open question`)
    return
  }
  // CONFIRMED or REFUTED without evidence cannot override a consensus: the verifier
  // claims to have checked the code but provides no citation. Treat as UNVERIFIABLE
  // so the finding stays as an open question rather than being falsely confirmed or
  // falsely dismissed on the basis of an unchecked assertion.
  if ((v.verdict === 'CONFIRMED' || v.verdict === 'REFUTED') && !(v.evidence || '').trim()) {
    resolution[id] = 'open'
    openQuestions.push(`[verification] ${c.path}:${c.line} — ${c.summary}: verifier returned ${v.verdict} without evidence — treated as UNVERIFIABLE`)
    return
  }
  if (v.verdict === 'REFUTED') {
    resolution[id] = 'dismissed'
    dismissReason[id] = `failed adversarial verification: ${v.reason}${v.evidence ? ` (${v.evidence})` : ''}`
  } else if (v.verdict === 'UNVERIFIABLE') {
    resolution[id] = 'open'
    openQuestions.push(`[verification] ${c.path}:${c.line} — ${c.summary}: ${v.reason}`)
  } else {
    c.verifiedEvidence = v.evidence || ''
  }
})

// Confirmed integration findings identifying broken consumers escalate to at least medium.
for (const c of candidates) {
  if (resolution[c.id] === 'confirmed' && c.sources.includes('integration') && c.severity === 'minor') c.severity = 'medium'
}

// ---------- Result ----------
const emit = (c) => ({
  id: c.id,
  severity: c.severity,
  path: c.path,
  line: c.line,
  summary: c.summary,
  evidence: c.evidence,
  impact: c.impact,
  consumerPath: c.consumerPath || null,
  consumerLine: c.consumerLine || null,
  sources: c.sources,
  flags: c.flags,
  votes: Object.fromEntries(participants.map((k) => [k, verdictFor(k, c)])),
  verifiedEvidence: c.verifiedEvidence || null,
})

const confirmed = candidates.filter((c) => resolution[c.id] === 'confirmed').map(emit)
const contested = candidates
  .filter((c) => contestedIds.includes(c.id))
  .map((c) => ({
    ...emit(c),
    positions: Object.fromEntries(
      participants.map((k) => [
        k,
        {
          verdict: verdictFor(k, c),
          reason: (evals[k][c.id] && evals[k][c.id].reason) || (c.sources.includes(k) ? 'original reporter' : 'no position'),
        },
      ]),
    ),
  }))
const dismissed = candidates
  .filter((c) => resolution[c.id] === 'dismissed')
  .map((c) => ({ ...emit(c), why: dismissReason[c.id] || 'no consensus' }))

log(`Done: ${confirmed.length} confirmed, ${contested.length} contested, ${dismissed.length} dismissed, ${openQuestions.length} open questions`)

return {
  status: 'ok',
  pr,
  headSha,
  prType,
  rounds: round,
  consensusReached: contested.length === 0,
  reviewerStatus,
  confirmed,
  contested,
  dismissed,
  openQuestions,
  residualRisk,
  positives,
}
