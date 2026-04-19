#!/usr/bin/env bash
set -euo pipefail

# 수동 통합 테스트용 설정 변경 케이스 러너
#
# 의도:
# - rep_target_cond 변경 시 metadata diff 경로가 실제로 동작하는지 확인한다.
# - prefix/suffix 변경 시 name transform 변경으로 인한 metadata 재동기화 경로를 확인한다.
#
# 주의:
# - 이 러너는 count보다 "변경 후 특정 tag가 실제로 보이는지"에 더 초점을 둔다.
# - 생성되는 generate jsonl 파일은 커밋 대상이 아니다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/../.." && pwd)"

MACHBASE_NEO_BIN="${MACHBASE_NEO_BIN:-/home/thlee/machbase-neo/machbase-neo}"
CGI_BASE_URL="${CGI_BASE_URL:-http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin}"
MANUAL_LOG_FILE="${MANUAL_LOG_FILE:-$REPO_ROOT/cgi-bin/docs/TESTLOG-manual-integration-$(date +%F).md}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$*" | tee -a "$MANUAL_LOG_FILE"
}

run_json_log() {
  local output
  output="$("$@")"
  printf '%s\n' "$output" | jq -c . | tee -a "$MANUAL_LOG_FILE" >/dev/null
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
  printf '%s\n' "$output" | jq -c . | tee -a "$MANUAL_LOG_FILE" >/dev/null
}

cleanup_job_tables() {
  local job="$1" src="$2" dst="$3"
  curl -s -X POST "$CGI_BASE_URL/api/rc/stop.js?name=$job" >/dev/null || true
  curl -s -X DELETE "$CGI_BASE_URL/api/rc.js?name=$job" >/dev/null || true
  run_jsh cgi-bin/tests/manual/integration_helper.js cleanup "$src" "$dst" >/dev/null || true
}

get_counts() {
  run_jsh cgi-bin/tests/manual/integration_helper.js counts "$1" "$2"
}

wait_target_counts() {
  local src="$1" dst="$2" want_rows="$3" want_meta="$4" timeout="${5:-180}"
  local start_ts now elapsed data tr tm
  start_ts="$(date +%s)"
  while true; do
    now="$(date +%s)"
    elapsed=$((now - start_ts))
    data="$(get_counts "$src" "$dst")"
    tr="$(printf '%s' "$data" | jq -r '.target.rows')"
    tm="$(printf '%s' "$data" | jq -r '.target.meta')"
    if [[ "$tr" == "$want_rows" && "$tm" == "$want_meta" ]]; then
      log "[wait] $dst rows=$tr meta=$tm matched in ${elapsed}s"
      return 0
    fi
    if (( elapsed >= timeout )); then
      log "[wait] timeout src=$src dst=$dst wantRows=$want_rows wantMeta=$want_meta got=$data"
      return 1
    fi
    sleep 2
  done
}

wait_target_meta_at_least() {
  local src="$1" dst="$2" want_meta="$3" timeout="${4:-180}"
  local start_ts now elapsed data tm
  start_ts="$(date +%s)"
  while true; do
    now="$(date +%s)"
    elapsed=$((now - start_ts))
    data="$(get_counts "$src" "$dst")"
    tm="$(printf '%s' "$data" | jq -r '.target.meta')"
    if (( tm >= want_meta )); then
      log "[wait] $dst meta reached $tm in ${elapsed}s"
      return 0
    fi
    if (( elapsed >= timeout )); then
      log "[wait] timeout meta src=$src dst=$dst wantMeta=$want_meta got=$data"
      return 1
    fi
    sleep 2
  done
}

case_rep_target_cond() {
  local job="it9rc" src="IT9S" dst="IT9D" gen_file="$REPO_ROOT/cgi-bin/docs/${job}_gen.jsonl"
  log "## Case $job start"
  cleanup_job_tables "$job" "$src" "$dst"
  run_jsh_json_log cgi-bin/tests/tag_meta_stress.js reset "$src" "$dst" 150

  local create_payload
  create_payload="$(jq -n \
    --arg name "$job" --arg src "$src" --arg dst "$dst" '
    {
      name: $name,
      config: {
        id: $name,
        source: {
          server: "local_native",
          table: $src,
          columns: ["NAME","TIME","VALUE"],
          meta: ["EQPID","EQPCNT"],
          rep_target_cond: {column: "NAME", op: "LIKE", value: ["TAG-00%"]},
          transform: []
        },
        target: {
          server: "local_http",
          table: $dst,
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

  run_json_log curl -s -X POST -H 'Content-Type: application/json' --data "$create_payload" "$CGI_BASE_URL/api/rc.js"
  run_json_log curl -s -X POST "$CGI_BASE_URL/api/rc/start.js?name=$job"
  wait_target_counts "$src" "$dst" 99 99 180
  log "[$job] initial filtered copy complete"

  local update_payload
  update_payload="$(jq -n --arg src "$src" --arg dst "$dst" '
    {
      id: "it9rc",
      source: {
        server: "local_native",
        table: $src,
        columns: ["NAME","TIME","VALUE"],
        meta: ["EQPID","EQPCNT"],
        rep_target_cond: {column: "NAME", op: "LIKE", value: ["TAG-01%"]},
        transform: []
      },
      target: {
        server: "local_http",
        table: $dst,
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
    }')"

  run_json_log curl -s -X PUT -H 'Content-Type: application/json' --data "$update_payload" "$CGI_BASE_URL/api/rc.js?name=$job"
  log "[$job] rep_target_cond updated to TAG-01%"
  run_jsh cgi-bin/tests/tag_meta_stress.js generate "$src" 30 200 100 >> "$gen_file"
  wait_target_meta_at_least "$src" "$dst" 150 180

  local sample
  sample="$(run_jsh cgi-bin/tests/manual/integration_helper.js tail-by-name "$dst" TAG-0100 3)"
  log "[$job] sample TAG-0100 $sample"
  if [[ "$(printf '%s' "$sample" | jq '.rows | length')" == "0" ]]; then
    log "[$job] TAG-0100 rows not found after condition change"
    exit 1
  fi

  cleanup_job_tables "$job" "$src" "$dst"
  rm -f "$gen_file"
  log "## Case $job done"
}

case_prefix_suffix() {
  local job="it10ps" src="I10S" dst="I10D" gen_file="$REPO_ROOT/cgi-bin/docs/${job}_gen.jsonl"
  log "## Case $job start"
  cleanup_job_tables "$job" "$src" "$dst"
  run_jsh_json_log cgi-bin/tests/tag_meta_stress.js reset "$src" "$dst" 100

  local create_payload
  create_payload="$(jq -n \
    --arg name "$job" --arg src "$src" --arg dst "$dst" '
    {
      name: $name,
      config: {
        id: $name,
        source: {
          server: "local_native",
          table: $src,
          columns: ["NAME","TIME","VALUE"],
          meta: ["EQPID","EQPCNT"],
          rep_target_cond: {column: null, op: "ALL", value: []},
          transform: []
        },
        target: {
          server: "local_native",
          table: $dst,
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

  run_json_log curl -s -X POST -H 'Content-Type: application/json' --data "$create_payload" "$CGI_BASE_URL/api/rc.js"
  run_json_log curl -s -X POST "$CGI_BASE_URL/api/rc/start.js?name=$job"
  wait_target_counts "$src" "$dst" 100 100 180
  log "[$job] initial untransformed copy complete"

  local update_payload
  update_payload="$(jq -n --arg src "$src" --arg dst "$dst" '
    {
      id: "it10ps",
      source: {
        server: "local_native",
        table: $src,
        columns: ["NAME","TIME","VALUE"],
        meta: ["EQPID","EQPCNT"],
        rep_target_cond: {column: null, op: "ALL", value: []},
        transform: [
          {
            criteria: {column: null, op: "ALL", value: []},
            expr: [
              {column: "NAME", type: "prefix", value: "P."},
              {column: "NAME", type: "suffix", value: ".X"}
            ]
          }
        ]
      },
      target: {
        server: "local_native",
        table: $dst,
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
    }')"

  run_json_log curl -s -X PUT -H 'Content-Type: application/json' --data "$update_payload" "$CGI_BASE_URL/api/rc.js?name=$job"
  log "[$job] prefix/suffix updated to P. / .X"
  run_jsh cgi-bin/tests/tag_meta_stress.js generate "$src" 30 200 100 >> "$gen_file"
  wait_target_meta_at_least "$src" "$dst" 200 180

  local sample
  sample="$(run_jsh cgi-bin/tests/manual/integration_helper.js tail-by-name "$dst" P.TAG-0001.X 3)"
  log "[$job] sample P.TAG-0001.X $sample"
  if [[ "$(printf '%s' "$sample" | jq '.rows | length')" == "0" ]]; then
    log "[$job] prefixed rows not found after transform change"
    exit 1
  fi

  cleanup_job_tables "$job" "$src" "$dst"
  rm -f "$gen_file"
  log "## Case $job done"
}

case_rep_target_cond
case_prefix_suffix
