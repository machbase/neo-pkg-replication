#!/usr/bin/env bash
set -euo pipefail

# 수동 통합 테스트용 mqtt-publish 케이스 러너
#
# 의도:
# - mqtt-publish는 DB query 검증이 불가능하므로 subscriber 기준으로 topic/payload/수신 row 합계를 검증한다.
# - append reply 검증은 제외하고, 실제 운영에서 필요한 publish 흐름과 restart 복구만 본다.
#
# 주의:
# - mosquitto_sub, jq 가 설치되어 있어야 한다.
# - payload capture 파일은 커밋 대상이 아니다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/../.." && pwd)"

MACHBASE_NEO_BIN="${MACHBASE_NEO_BIN:-/home/thlee/machbase-neo/machbase-neo}"
CGI_BASE_URL="${CGI_BASE_URL:-http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin}"
MANUAL_LOG_FILE="${MANUAL_LOG_FILE:-$REPO_ROOT/cgi-bin/docs/TESTLOG-manual-integration-$(date +%F).md}"

JOB="${1:?job name required}"
SRC_SERVER="${2:?source server required}"
SRC_TABLE="${3:?source table required}"
DUMMY_DST_TABLE="${4:?dummy dst table required}"
TOPIC="${5:?mqtt topic required}"
SEED_TAGS="${6:-300}"
PRE_DURATION="${7:-30}"
LIVE_DURATION="${8:-45}"
BATCH_SIZE="${9:-300}"
TICK_MS="${10:-100}"

PRE_FILE="$REPO_ROOT/cgi-bin/docs/${JOB}_pre_generate.jsonl"
LIVE_FILE="$REPO_ROOT/cgi-bin/docs/${JOB}_live_generate.jsonl"
PAYLOAD_FILE="$REPO_ROOT/cgi-bin/docs/${JOB}_mqtt_payload.jsonl"
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
  run_jsh cgi-bin/tests/manual/integration_helper.js cleanup "$SRC_TABLE" "$DUMMY_DST_TABLE" >/dev/null || true
  rm -f "$PAYLOAD_FILE" "$PRE_FILE" "$LIVE_FILE"
}

trap cleanup_case EXIT

find_pid() {
  pgrep -f "replication.js ${JOB}$" | head -n 1 || true
}

subscriber_rows() {
  if [[ ! -s "$PAYLOAD_FILE" ]]; then
    echo 0
    return
  fi
  jq -s 'map((.rows | length)) | add // 0' "$PAYLOAD_FILE"
}

subscriber_columns_ok() {
  if [[ ! -s "$PAYLOAD_FILE" ]]; then
    echo false
    return
  fi
  jq -r 'select((.columns | index("EQPID")) and (.columns | index("EQPCNT"))) | "true"' "$PAYLOAD_FILE" | head -n 1
}

log "## Case $JOB start"
cleanup_case
CLEANED=0

log "[$JOB] reset tables src=$SRC_TABLE dummyDst=$DUMMY_DST_TABLE seedTags=$SEED_TAGS"
run_jsh_json_log cgi-bin/tests/tag_meta_stress.js reset "$SRC_TABLE" "$DUMMY_DST_TABLE" "$SEED_TAGS"

log "[$JOB] pre-generate start duration=${PRE_DURATION}s batch=${BATCH_SIZE} tick=${TICK_MS}ms"
run_jsh cgi-bin/tests/tag_meta_stress.js generate "$SRC_TABLE" "$PRE_DURATION" "$BATCH_SIZE" "$TICK_MS" >> "$PRE_FILE"
log "[$JOB] pre-generate done"

payload="$(jq -n \
  --arg name "$JOB" \
  --arg srcServer "$SRC_SERVER" \
  --arg srcTable "$SRC_TABLE" \
  --arg dstTable "$DUMMY_DST_TABLE" \
  --arg topic "$TOPIC" \
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
        server: "local_mqtt_publish",
        table: $dstTable,
        topic: $topic,
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

log "[$JOB] start subscriber topic=$TOPIC"
mosquitto_sub -h 127.0.0.1 -p 5653 -t "$TOPIC" > "$PAYLOAD_FILE" &
SUB_PID=$!
sleep 1

log "[$JOB] create replicator"
run_json_log curl -s -X POST -H 'Content-Type: application/json' --data "$payload" "$CGI_BASE_URL/api/rc.js"
log "[$JOB] start replicator"
run_json_log curl -s -X POST "$CGI_BASE_URL/api/rc/start.js?name=$JOB"

sleep 15
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
sleep 20

log "[$JOB] stop replicator/subscriber"
run_json_log curl -s -X POST "$CGI_BASE_URL/api/rc/stop.js?name=$JOB" || true
sleep 2
kill "$SUB_PID" >/dev/null 2>&1 || true
wait "$SUB_PID" 2>/dev/null || true

SRC_ROWS="$(run_jsh cgi-bin/tests/manual/integration_helper.js counts "$SRC_TABLE" "$DUMMY_DST_TABLE" | jq -r '.source.rows')"
SUB_ROWS="$(subscriber_rows)"
COLUMNS_OK="$(subscriber_columns_ok || true)"

log "[$JOB] mqtt-publish summary srcRows=$SRC_ROWS subscriberRows=$SUB_ROWS columnsWithMeta=$COLUMNS_OK"
if [[ "$SRC_ROWS" != "$SUB_ROWS" ]]; then
  log "[$JOB] mismatch source rows vs subscriber rows"
  exit 1
fi
if [[ "$COLUMNS_OK" != "true" ]]; then
  log "[$JOB] payload metadata columns not observed"
  exit 1
fi

cleanup_case
log "## Case $JOB done"
