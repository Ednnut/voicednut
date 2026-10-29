#!/usr/bin/env bash
# VOICEDNUT repo-wide verification pass. Run from anywhere; paths are repo-root relative.
# Usage:
#   scripts/verify.sh              # fast pass: api lint+tests, bot tests, miniapp validate:prod
#   scripts/verify.sh --browser    # + Playwright e2e and a11y (needs chromium binaries)
#   scripts/verify.sh --coverage   # + npx c8 coverage of the API suite (downloads c8 on first use; leaves api/coverage/ scratch)
#   scripts/verify.sh --lint-bot   # reserved: bot has no linter yet (see docs/codex-toolkit.md); flag exists so callers stay stable
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
RUN_BROWSER=0
RUN_COVERAGE=0
for arg in "$@"; do
  case "$arg" in
    --browser) RUN_BROWSER=1 ;;
    --coverage) RUN_COVERAGE=1 ;;
    --lint-bot) ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

declare -a NAMES=() CMDS=() RESULTS=()
run_step() {
  local name="$1" dir="$2" cmd="$3"
  local idx=${#NAMES[@]}
  NAMES+=("$name"); CMDS+=("($dir) $cmd"); RESULTS+=("PENDING")
  local start=$(date +%s%3N 2>/dev/null || date +%s000)
  if (cd "$ROOT/$dir" && eval "$cmd") > "/tmp/verify-$$.log" 2>&1; then
    local ms=$(( $(date +%s%3N 2>/dev/null || date +%s000) - start ))
    RESULTS[$idx]="PASS ${ms}ms  $(grep -oE '[0-9]+ (passing|problems)' /tmp/verify-$$.log | tail -1)"
  else
    RESULTS[$idx]="FAIL: $(tr '\n' ' ' < "/tmp/verify-$$.log" | tail -c 300)"
  fi
  rm -f "/tmp/verify-$$.log"
  echo "${RESULTS[$idx]:0:4}  $name" >&2
}

echo "== VOICEDNUT verify @ $(date -u +%FT%TZ) ==" >&2
run_step "api lint"        "api"     "npm run lint --silent"
run_step "api tests"       "api"     "npm test -- --reporter dot"
run_step "api profile packs" "api"   "npm run validate:profiles --silent"
run_step "bot tests"       "bot"     "npm test --silent"
run_step "miniapp contracts+lint+build" "miniapp" "npm run validate:prod"
if [ "$RUN_BROWSER" = "1" ]; then
  run_step "miniapp e2e"   "miniapp" "npm run test:e2e"
  run_step "miniapp a11y"  "miniapp" "npm run test:a11y"
fi
if [ "$RUN_COVERAGE" = "1" ]; then
  run_step "api coverage"  "api"     "npx --yes c8 --reporter=text-summary npm test"
fi
run_step "git diff --check" "." "git diff --check"

echo; echo "RESULT TABLE"; 
for i in "${!NAMES[@]}"; do printf '%-34s %-70s %s\n' "${NAMES[$i]}" "${CMDS[$i]}" "${RESULTS[$i]}"; done
fail=0; for r in "${RESULTS[@]}"; do [[ "$r" == FAIL* ]] && fail=1; done
echo; [ "$fail" = "0" ] && echo "ALL GREEN" || echo "FAILURES PRESENT — inspect above"
exit $fail