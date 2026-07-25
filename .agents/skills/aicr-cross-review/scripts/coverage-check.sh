#!/usr/bin/env bash
# Cross-review Go coverage check. Bash only — zsh word-splitting of unquoted
# variables differs; always invoke as `bash coverage-check.sh ...`.
#
# Usage: bash coverage-check.sh <repo-path> <pr-number> <expected-sha> <base-branch> <base-sha> <changed-pkg-glob> [...more]
#   e.g. bash coverage-check.sh ~/projects/aicr 1234 abc123def main a1b2c3d4 ./pkg/bundler/... ./pkg/recipe/...
#
# The 3rd argument is the pinned headSha captured in Phase 1. The script verifies
# the fetched PR head matches before running tests, so a mid-review author push
# is caught and reported rather than silently measuring a different commit.
# The 4th argument is the PR's base branch (baseRefName from gh pr view) — NOT
# hardcoded to "main", because PRs may target other branches.
# The 5th argument is the pinned base SHA captured in Phase 1 sub-batch B. The
# script verifies the fetched base matches, so coverage uses the exact commit the
# diff was computed against — not a newer commit if the base advanced mid-review.
#
# SECURITY: this script executes PR-supplied Go code (go test, make test-coverage)
# in throwaway worktrees. For PRs from untrusted forks, the code can do anything
# your account can do. Only run cross-review on PRs you have inspected and trust
# to execute — treat this the same as running `go test` on an untrusted patch.
#
# Measures changed-package coverage on the PR head vs the base branch in throwaway
# worktrees under $TMPDIR, then runs the project-wide floor check. NEVER mutates
# the active working copy: no coverprofile in the tree, no branch switching —
# a concurrent session may be on that branch and the user's checkout must stay
# untouched. Designed to launch in the background at cross-review Phase 1 so it
# overlaps the reviews instead of serializing after them.
set -euo pipefail

REPO="${1:?usage: coverage-check.sh <repo-path> <pr-number> <expected-sha> <base-branch> <base-sha> <pkg-globs...>}"
PRNUM="${2:?missing pr number}"
EXPECTED_SHA="${3:?missing expected sha}"
BASE_BRANCH="${4:?missing base branch (e.g. main)}"
EXPECTED_BASE_SHA="${5:?missing base sha}"
shift 5
CHANGED="$*"
[ -n "$CHANGED" ] || { echo "no changed Go packages passed — nothing to measure"; exit 1; }

# Per-invocation scoped refs to avoid collisions when concurrent reviews run.
# Using invocation-scoped refs (not origin/main) also guarantees the base worktree
# sees the freshly-fetched main, not a potentially stale local tracking branch
# (git fetch origin main without a refspec writes FETCH_HEAD, not origin/main).
PRREF="refs/cr/pr-${PRNUM}-$$"
MAINREF="refs/cr/main-${PRNUM}-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cr-cov.XXXXXX")   # unique per run — no fixed-path collisions

# ALWAYS clean up — worktrees, temp dir, AND the fetched refs — on success or any
# failure/early-exit (set -e), via trap. Leaving refs/cr/* behind would pollute
# the shared repo across runs; leaked worktrees eventually break the sandbox
# profile for all future sessions (E2BIG at ~70 worktrees, hit 2026-07-02).
cleanup() {
  git -C "$REPO" worktree remove --force "$WORK/pr"   2>/dev/null || true
  git -C "$REPO" worktree remove --force "$WORK/base" 2>/dev/null || true
  git -C "$REPO" update-ref -d "$PRREF"   2>/dev/null || true
  git -C "$REPO" update-ref -d "$MAINREF" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Fetch both the PR head and base branch in a single network round-trip.
# refs/pull/N/head always resolves (bare SHA fetch fails for fork PRs).
# The base branch is fetched into MAINREF so the base worktree uses the
# freshly fetched commit — not whatever the stale local tracking branch resolves to.
git -C "$REPO" fetch origin \
  "+refs/heads/${BASE_BRANCH}:$MAINREF" \
  "+refs/pull/$PRNUM/head:$PRREF"
PRHEAD=$(git -C "$REPO" rev-parse "$PRREF")
BASEHEAD=$(git -C "$REPO" rev-parse "$MAINREF")
# Verify the fetched PR head matches the headSha captured in Phase 1. If the author
# pushed after Phase 1, bail out rather than measure a different commit from what
# the reviewers are seeing.
if [ "$PRHEAD" != "$EXPECTED_SHA" ]; then
  echo "COVERAGE INVALID: fetched PR head $PRHEAD does not match expected $EXPECTED_SHA (author may have pushed mid-review)."
  exit 1
fi
# Verify the fetched base matches the base SHA captured when the diff was generated.
# If the base advanced mid-review the coverage delta would be against a different
# ancestor than the diff, producing misleading per-package comparisons.
if [ "$BASEHEAD" != "$EXPECTED_BASE_SHA" ]; then
  echo "COVERAGE INVALID: fetched base $BASEHEAD does not match expected $EXPECTED_BASE_SHA (base branch advanced mid-review)."
  exit 1
fi
git -C "$REPO" worktree add --detach "$WORK/pr"   "$PRHEAD"
git -C "$REPO" worktree add --detach "$WORK/base" "$MAINREF"

# Build PR and base package lists.
# - PR_PKGS: packages that EXIST in the PR worktree (skip deleted packages — go test
#   ./deleted/... exits 1, producing a false COVERAGE INVALID).
# - BASE_PKGS: packages that exist on the base commit (skip new packages — no baseline).
PR_PKGS=""
BASE_PKGS=""
for p in $CHANGED; do
  d=${p#./}; d=${d%/...}
  if [ -d "$WORK/pr/$d" ]; then PR_PKGS="$PR_PKGS $p"; else echo "deleted package (not in PR): $p"; fi
  if [ -d "$WORK/base/$d" ]; then BASE_PKGS="$BASE_PKGS $p"; else echo "new package (no base): $p"; fi
done

failed=0
run_cov() { # $1=worktree $2=profile $3=packages
  [ -z "$3" ] && { echo "(no packages for $1 — skipping)"; return 0; }
  if ! (cd "$WORK/$1" && GOFLAGS="-mod=vendor" go test -coverprofile="$2" $3) >"$WORK/$1.log" 2>&1; then
    echo "go test FAILED for $1 — last lines:"; tail -5 "$WORK/$1.log"; failed=1
  fi
}
run_cov pr   "$WORK/pr.cov"   "$PR_PKGS"
run_cov base "$WORK/base.cov" "$BASE_PKGS"

pkg_coverage() { # $1=profile-file $2=label
  # Compute per-package statement coverage from the raw .cov profile.
  # Each profile line: "pkg/path/file.go:start.col,end.col stmts hits"
  # Groups by package path (directory of the file), computes stmts and hits totals.
  [ -f "$1" ] || { echo "($2: coverage file not found)"; return; }
  python3 - "$1" "$2" <<'PYEOF'
import sys, collections
profile, label = sys.argv[1], sys.argv[2]
stmts   = collections.defaultdict(int)
covered = collections.defaultdict(int)
for line in open(profile):
    line = line.strip()
    if line.startswith('mode:') or not line: continue
    parts = line.rsplit(' ', 2)
    if len(parts) != 3: continue
    filepath, n, h = parts
    # strip :line.col,line.col — keep only the directory (package path)
    pkg = filepath.rsplit('/', 1)[0] if '/' in filepath else '.'
    num_stmts = int(n)
    # A statement block is covered if its execution count (h) > 0.
    # Add num_stmts (not h) to covered — summing hit counts produces values > 100%.
    stmts[pkg]   += num_stmts
    covered[pkg] += num_stmts if int(h) > 0 else 0
print(f"=== {label} per-package statement coverage ===")
for pkg in sorted(stmts):
    s = stmts[pkg]
    pct = 100.0 * covered[pkg] / s if s > 0 else 0.0
    print(f"{pkg}: {pct:.1f}%  ({covered[pkg]}/{s} stmts)")
PYEOF
}

if [ "$failed" -ne 0 ]; then
  echo "COVERAGE INVALID: a go test run failed on pr and/or base; delta cannot be trusted."
  echo "Triage: re-check whether the failure also occurs on origin/main (pre-existing/env) before treating it as a PR finding."
else
  # Full per-function listing so the orchestrator can flag new exported functions at 0%.
  # Must run inside $WORK/pr: go tool cover -func resolves source files via the module
  # root of the current directory; new or moved packages absent from the shared checkout
  # cause the tool to fail, aborting the script under set -euo pipefail.
  echo "=== PR per-function coverage (changed packages) ==="
  [ -f "$WORK/pr.cov" ] && (cd "$WORK/pr" && go tool cover -func="$WORK/pr.cov")
  echo "=== Totals ==="
  echo "PR total:"; [ -f "$WORK/pr.cov" ] && (cd "$WORK/pr" && go tool cover -func="$WORK/pr.cov" | tail -1)
  # Per-package statement coverage from the raw profiles — enables per-package delta check.
  pkg_coverage "$WORK/pr.cov" "PR"
  if [ -n "$BASE_PKGS" ]; then
    pkg_coverage "$WORK/base.cov" "BASE"
  else
    echo "BASE: n/a (all changed packages are new)"
  fi
fi

# PROJECT-WIDE FLOOR — must run HERE, while $WORK/pr and $WORK/base still exist.
# Staged classifier with an UNAMBIGUOUS threshold check. make test-coverage depends
# on the phony test target, so invoking it plainly reruns the whole suite — a flaky
# second run corrupts the verdict (false FLOOR: FAIL when the rerun flakes, false
# PASS when a real failure flakes green). Instead: run make test ONCE (it produces
# coverage.out in the worktree), then check the threshold alone with
# `make -o test test-coverage` — GNU make -o marks the test target as up-to-date so
# it is not remade. A failure from that command can ONLY mean the threshold was
# evaluated and missed.
echo "=== Project floor ==="
floor_check() { # $1=worktree subdir — threshold-only check, never reruns tests
  (cd "$WORK/$1" && make -o test test-coverage) 2>/dev/null
}
pr_test_ok=0; base_test_ok=0; pr_floor_ok=0; base_floor_ok=0
(cd "$WORK/pr" && make test) 2>/dev/null && pr_test_ok=1 || true
if [ "$pr_test_ok" -eq 1 ]; then
  floor_check pr && pr_floor_ok=1 || true
  if [ "$pr_floor_ok" -eq 0 ]; then
    # PR is genuinely below threshold; measure the base to attribute the regression.
    (cd "$WORK/base" && make test) 2>/dev/null && base_test_ok=1 || true
    if [ "$base_test_ok" -eq 1 ]; then
      floor_check base && base_floor_ok=1 || true
    fi
  fi
else
  (cd "$WORK/base" && make test) 2>/dev/null && base_test_ok=1 || true
fi
if   [ "$pr_test_ok" -eq 0 ] && [ "$base_test_ok" -eq 0 ]; then
  # Tests fail on both sides — environmental or pre-existing, not a PR regression.
  echo "FLOOR: PRE-EXISTING TEST FAIL (make test fails on base too — do not file as PR finding)"
  failed=1
elif [ "$pr_test_ok" -eq 0 ]; then
  # Tests fail only on the PR side — a test regression, not a coverage threshold issue.
  echo "FLOOR: TEST FAIL (make test failed in PR worktree but passes on base — fix test regressions first)"
  failed=1
elif [ "$pr_floor_ok" -eq 1 ]; then
  echo "FLOOR: PASS"
elif [ "$base_test_ok" -eq 0 ]; then
  # PR threshold verdict is valid (below floor); base baseline is unmeasurable.
  echo "FLOOR: FAIL (PR is below .settings.yaml quality.coverage_threshold; base baseline unavailable — base tests fail)"
  failed=1
elif [ "$base_floor_ok" -eq 0 ]; then
  # Both below the threshold — pre-existing; not attributable to this PR. Still exit
  # nonzero so the orchestrator knows coverage was not fully validated.
  echo "FLOOR: PRE-EXISTING FAIL (base also fails — do not file as critical PR finding)"
  failed=1
else
  echo "FLOOR: FAIL (PR is below .settings.yaml quality.coverage_threshold; base passes)"
  failed=1
fi

exit "$failed"
