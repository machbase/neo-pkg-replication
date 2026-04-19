#!/usr/bin/env bash
set -euo pipefail

# 수동 통합 테스트용 DB target 케이스 러너
#
# 의도:
# - native/http/mqtt-api 처럼 target 상태를 DB에서 직접 검증할 수 있는 조합을 같은 흐름으로 돌린다.
# - pre-generate -> initial drain -> live generate -> kill -9 -> restart -> final drain -> verify를 표준화한다.
#
# 주의:
# - 실행 로그와 generate jsonl 산출물은 커밋 대상이 아니다.
# - 종료/오류 시에도 cleanup이 동작하도록 trap을 건다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/../.." && pwd)"

MACHBASE_NEO_BIN="${MACHBASE_NEO_BIN:-/home/thlee/machbase-neo/machbase-neo}"
CGI_BASE_URL="${CGI_BASE_URL:-http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin}"
MANUAL_LOG_FILE="${MANUAL_LOG_FILE:-$REPO_ROOT/cgi-bin/docs/TESTLOG-manual-integration-$(date +%F).md}"

JOB="${1:?job name required}"
SRC_SERVER="${2:?source server required}"
TGT_SERVER="${3:?target server required}"
SRC_TABLE="${4:?source table required}"
DST_TABLE="${5:?target table required}"
SEED_TAGS="${6:-300}"
PRE_DURATION="${7:-30}"
LIVE_DURATION="${8:-45}"
BATCH_SIZE="${9:-300}"
TICK_MS="${10:-100}"

PRE_FILE="$REPO_ROOT/cgi-bin/docs/${JOB}_pre_generate.jsonl"
LIVE_FILE="$REPO_ROOT/cgi-bin/docs/${JOB}_live_generate.jsonl"
CLEANED=0

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$*" | tee -a "$MANUAL_LOG_FILE"
}

json_pp() {
  jq -c .
}

run_json_log() {
  local output
  output="$("$@")"
  printf '%s\n' "$output" | json_pp | tee -a "$MANUAL_LOG_FILE" >/dev/null
}

run_jsh() {
  local script="$1"
  shift
  # machbase-neo jsh 는 이 환경에서 스크립트 절대경로 호출이 불안정하므로
  # repo root 기준 상대경로로 고정해서 실행한다.
  (
    cd "$REPO_ROOT"
    "$MACHBASE_NEO_BIN" jsh "$script" "$@"
  )
}

run_jsh_json_log() {
  local script="$1"
  shift
  local output
  output="$(run_jsh "$script" "$@")"
  printf '%s\n' "$output" | json_pp | tee -a "$MANUAL_LOG_FILE" >/dev/null
}

cleanup_case() {
  if [[ "$CLEANED" == "1" ]]; then
    return
  fi
  CLEANED=1
  curl -s -X POST "$CGI_BASE_URL/api/rc/stop.js?name=$JOB" >/dev/null || true
  curl -s -X DELETE "$CGI_BASE_URL/api/rc.js?name=$JOB" >/dev/null || true
  run_jsh cgi-bin/tests/manual/integration_helper.js cleanup "$SRC_TABLE" "$DST_TABLE" >/dev/null || true
  rm -f "$PRE_FILE" "$LIVE_FILE"
}

trap cleanup_case EXIT

wait_drain() {
  local timeout_sec="${1:-300}"
  local start_ts now_ts elapsed counts src_rows dst_rows src_meta dst_meta
  start_ts="$(date +%s)"
  while true; do
    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    counts="$(run_jsh cgi-bin/tests/manual/integration_helper.js counts "$SRC_TABLE" "$DST_TABLE" | jq -c .)"
    src_rows="$(printf '%s' "$counts" | jq -r '.source.rows')"
    dst_rows="$(printf '%s' "$counts" | jq -r '.target.rows')"
    src_meta="$(printf '%s' "$counts" | jq -r '.source.meta')"
    dst_meta="$(printf '%s' "$counts" | jq -r '.target.meta')"
    if [[ "$src_rows" == "$dst_rows" && "$src_meta" == "$dst_meta" ]]; then
      log "[$JOB] drain complete rows=$src_rows meta=$src_meta elapsed=${elapsed}s"
      return 0
    fi
    if (( elapsed >= timeout_sec )); then
      log "[$JOB] drain timeout after ${elapsed}s counts=$counts"
      return 1
    fi
    sleep 2
  done
}

find_pid() {
  pgrep -f "replication.js ${JOB}$" | head -n 1 || true
}

log "## Case $JOB start"
cleanup_case
CLEANED=0

log "[$JOB] reset tables src=$SRC_TABLE dst=$DST_TABLE seedTags=$SEED_TAGS"
run_jsh_json_log cgi-bin/tests/tag_meta_stress.js reset "$SRC_TABLE" "$DST_TABLE" "$SEED_TAGS"

log "[$JOB] pre-generate start duration=${PRE_DURATION}s batch=${BATCH_SIZE} tick=${TICK_MS}ms"
run_jsh cgi-bin/tests/tag_meta_stress.js generate "$SRC_TABLE" "$PRE_DURATION" "$BATCH_SIZE" "$TICK_MS" >> "$PRE_FILE"
log "[$JOB] pre-generate done"

payload="$(jq -n \
  --arg name "$JOB" \
  --arg srcServer "$SRC_SERVER" \
  --arg tgtServer "$TGT_SERVER" \
  --arg srcTable "$SRC_TABLE" \
  --arg dstTable "$DST_TABLE" \
  '{
    name: $name,
    config: {
      id: $name,
      source: {
        server: $srcServer,
        table: $srcTable,
        columns: ["NAME","TIME","VALUE"],
        meta: ["EQPID","EQPCNT"],
        rep_target_cond: {column: null, op: "ALL", value: []},
        transform: []
      },
      target: {
        server: $tgtServer,
        table: $dstTable,
        columns: ["NAME","TIME","VALUE"],
        meta: ["EQPID","EQPCNT"]
      },
      startMode: "full",
      queryLimit: 5000,
      pollIntervalMs: 500,
      shutdownTimeoutMs: 30000,
      onSaveFailure: "continue",
      retry: {maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 30000},
      logging: {level: "info", maxFiles: 5}
    }
  }')"

log "[$JOB] create replicator"
run_json_log curl -s -X POST -H 'Content-Type: application/json' --data "$payload" "$CGI_BASE_URL/api/rc.js"

log "[$JOB] start replicator"
run_json_log curl -s -X POST "$CGI_BASE_URL/api/rc/start.js?name=$JOB"

wait_drain 300

log "[$JOB] live generate start duration=${LIVE_DURATION}s"
run_jsh cgi-bin/tests/tag_meta_stress.js generate "$SRC_TABLE" "$LIVE_DURATION" "$BATCH_SIZE" "$TICK_MS" >> "$LIVE_FILE" &
GEN_PID=$!

sleep $(( LIVE_DURATION / 3 ))
PID="$(find_pid)"
if [[ -n "$PID" ]]; then
  log "[$JOB] kill -9 pid=$PID"
  kill -9 "$PID"
else
  log "[$JOB] warning: pid not found for kill -9"
fi

sleep 5
log "[$JOB] restart after kill"
run_json_log curl -s -X POST "$CGI_BASE_URL/api/rc/start.js?name=$JOB"

wait "$GEN_PID"
log "[$JOB] live generate done"

wait_drain 360

log "[$JOB] summary"
run_jsh_json_log cgi-bin/tests/tag_meta_stress.js summary "$SRC_TABLE" "$DST_TABLE"

log "[$JOB] verify"
run_jsh_json_log cgi-bin/tests/tag_meta_stress.js verify "$SRC_TABLE" "$DST_TABLE"

log "[$JOB] cleanup end"
cleanup_case
log "## Case $JOB done"
