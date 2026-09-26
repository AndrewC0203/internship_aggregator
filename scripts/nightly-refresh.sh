#!/bin/bash
# Nightly ingestion refresh (Decision 37). Run by launchd at 02:30 — see
# scripts/com.internship-aggregator.nightly-refresh.plist.
#
# Three gates, then a paced full `npm run refresh`:
#   1. AC power    — never burn battery. launchd can't express this condition, so the job
#                    always fires and this script decides. Skipping is success (exit 0):
#                    a battery night is policy working, not a failure to alert on.
#   2. Night window (00:00–07:59) — launchd coalesces a slept-through 02:30 into a run at
#                    next wake; without this gate that run lands mid-workday with the fans
#                    on. A skipped night just waits for the next 02:30 — freshness cost is
#                    one day, and ETag/304 + seen-listing partitioning make the catch-up
#                    run no bigger than the run it replaces.
#   3. Single instance — a manual refresh and the nightly must not interleave writes.
#
# Fan control: OLLAMA_MIN_INTERVAL_MS (src/model/ollama.ts) spaces model-call starts so
# the GPU idles between calls instead of running flat out for the whole AI tail.
# `caffeinate -s` holds the Mac awake while the run is in flight — the -s assertion is
# only effective on AC power, matching gate 1.
#
# Usage:
#   scripts/nightly-refresh.sh                  # gated (what launchd runs)
#   scripts/nightly-refresh.sh --now            # bypass gates 1+2 (manual run)
#   scripts/nightly-refresh.sh --now --limit 2  # extra args pass through to refresh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/nightly-refresh-$(date +%F).log"
exec >>"$LOG" 2>&1

# Keep two weeks of nightly logs; scoped to this script's own naming pattern.
find "$LOG_DIR" -name 'nightly-refresh-*.log' -mtime +14 -delete 2>/dev/null

echo "=== nightly-refresh invoked $(date '+%F %T') ==="

NOW_MODE=0
PASS_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--now" ]; then NOW_MODE=1; else PASS_ARGS+=("$arg"); fi
done

if [ "$NOW_MODE" -eq 0 ]; then
  # Gate 1: AC power. First line of `pmset -g ps` is "Now drawing from 'AC Power'"/'Battery Power'.
  if ! pmset -g ps | head -1 | grep -q "AC Power"; then
    echo "on battery — skipping (plug in to allow the nightly run)"
    exit 0
  fi
  # Gate 2: night window. 10# forces base-10 so "08"/"09" don't parse as bad octal.
  hour=$(date +%H)
  if (( 10#$hour >= 8 )); then
    echo "outside the 00:00-07:59 window (hour=$hour) — skipping until the next 02:30"
    exit 0
  fi
fi

# Gate 3: single instance. mkdir is atomic; a lock whose pid is dead is stale (crash/reboot).
LOCK="$REPO/.nightly-refresh.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    echo "another refresh holds the lock (pid $(cat "$LOCK/pid")) — skipping"
    exit 0
  fi
  echo "stale lock found — removing and continuing"
  rm -rf "$LOCK"
  mkdir "$LOCK" || exit 1
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# launchd starts jobs with a bare PATH; build the one this project needs. Node comes from
# nvm — source it (guarded: nvm.sh predates `set -u` discipline) rather than hardcoding a
# version dir that breaks on the next `nvm install`.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u
  . "$HOME/.nvm/nvm.sh"
  set -u
fi
if ! command -v npm >/dev/null; then
  echo "FATAL: npm not on PATH after nvm load"
  exit 1
fi

# GPU duty cycle (see src/model/ollama.ts): ~2.6s classify + 6s start-to-start gap ≈ 43%.
# Raise to run cooler/slower, lower toward 0 to run hot/fast. Respects a pre-set value.
export OLLAMA_MIN_INTERVAL_MS="${OLLAMA_MIN_INTERVAL_MS:-6000}"

# Tighter per-call timeout for unattended runs (interactive default: 120s). Poison rows
# (constrained-decoding hangs — see FEATURES.md 2026-09-25) burn timeout×4 attempts of
# PINNED GPU each, every pass, which the duty-cycle gate can't dampen (it spaces call
# starts, not in-flight hangs). Legit calls run 2-5s warm, ~+5s on a cold model load —
# 45s is >5x the worst observed legitimate call. Worst case if it ever bites a real call:
# one lost batch chunk, re-covered by the next night's run.
export OLLAMA_TIMEOUT_MS="${OLLAMA_TIMEOUT_MS:-45000}"

# Ensure Ollama is up; if we start it, we stop it after — the nightly shouldn't leave a
# model server (and its resident models) behind that the user didn't start.
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
STARTED_OLLAMA_PID=""
if ! curl -fsS --max-time 5 "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
  echo "ollama not running — starting it for this run"
  ollama serve >>"$LOG_DIR/ollama-nightly.log" 2>&1 &
  STARTED_OLLAMA_PID=$!
  for _ in $(seq 1 30); do
    curl -fsS --max-time 2 "$OLLAMA_URL/api/version" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -fsS --max-time 5 "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
    echo "FATAL: ollama did not come up within 30s"
    kill "$STARTED_OLLAMA_PID" 2>/dev/null
    exit 1
  fi
fi

cd "$REPO"
echo "starting refresh (OLLAMA_MIN_INTERVAL_MS=$OLLAMA_MIN_INTERVAL_MS) $(date '+%F %T')"
start_ts=$(date +%s)

# ${arr[@]+...} expansion: macOS ships bash 3.2, where "${arr[@]}" on an empty array
# trips `set -u`.
caffeinate -s npm run refresh -- ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
status=$?

elapsed=$(( $(date +%s) - start_ts ))
echo "refresh exited with status $status after $((elapsed / 60))m$((elapsed % 60))s"

if [ -n "$STARTED_OLLAMA_PID" ]; then
  echo "stopping the ollama instance this run started"
  kill "$STARTED_OLLAMA_PID" 2>/dev/null
fi

echo "=== nightly-refresh done $(date '+%F %T') ==="
exit "$status"
