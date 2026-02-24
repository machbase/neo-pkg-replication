'use strict';

/**
 * E2E 시나리오 단위 테스트 (mock 기반)
 *
 * 검증 대상 (미완료 항목):
 *   E2E-02: SIGKILL 후 재시작 — 중복 없이 이후 데이터 복제, skipped_exists > 0
 *   E2E-03: SIGTERM graceful — shutdown_timeout_ms 이내 종료, cp 최신 상태
 *   E2E-05: LOG 테이블 복제 — STARTUP_INTEGRITY 미수행 (로그 확인)
 *   E2E-06: 대상 DB 연결 차단 → retry 로그 → 복구 후 자동 재개
 *   E2E-07: cp 파일 손상 → start_mode 기준 시작, stage="checkpoint_io" 로그
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const { runDataTableWorker } = require('../../worker/worker.js');
const CheckpointStore = require('../../file/checkpoint.js');

// ─── 공통 헬퍼 ───────────────────────────────────────────────────────────────

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'e2e-test-'));
}

function baseMapping(overrides = {}) {
  return {
    source: { server: 'src', table: 'TAG' },
    target: { server: 'dst', table: 'TAG2' },
    execution: {
      batch_size_records: 100,
      poll_interval_ms: 20,
      start_mode: 'full',
      on_save_failure: 'continue',
      integrity: { enabled: false },
      ...overrides,
    },
  };
}

function logMapping(overrides = {}) {
  return {
    source: { server: 'src', table: 'LOG_TABLE' },
    target: { server: 'dst', table: 'LOG_TABLE2' },
    execution: {
      batch_size_records: 100,
      poll_interval_ms: 20,
      start_mode: 'full',
      on_save_failure: 'continue',
      integrity: { enabled: true },
      ...overrides,
    },
  };
}

/** require 캐시에서 모듈을 가져와 메서드를 원숭이 패치, 복원 함수 반환 */
function patchSourceReader(readFn, maxRidFn) {
  const SR = require('../../machbase/source_reader.js');
  const origRead = SR.readAfterRid;
  const origMax = SR.getMaxRid;
  if (readFn) SR.readAfterRid = readFn;
  if (maxRidFn) SR.getMaxRid = maxRidFn;
  return () => {
    SR.readAfterRid = origRead;
    SR.getMaxRid = origMax;
  };
}

function patchTagMeta(loadAllFn, resolveFn) {
  const TMP = require('../../machbase/tag_meta_provider.js');
  const origLoad = TMP.prototype.loadAll;
  const origResolve = TMP.prototype.resolveTagCanonical;
  if (loadAllFn) TMP.prototype.loadAll = loadAllFn;
  if (resolveFn) TMP.prototype.resolveTagCanonical = resolveFn;
  return () => {
    TMP.prototype.loadAll = origLoad;
    TMP.prototype.resolveTagCanonical = origResolve;
  };
}

function patchIntegrityChecker(batchExistsFn) {
  const IC = require('../../machbase/integrity_checker.js');
  const origBatch = IC.batchExists;
  if (batchExistsFn) IC.batchExists = batchExistsFn;
  return () => { IC.batchExists = origBatch; };
}

function patchMachbaseClient() {
  const mod = require('../../machbase/machbase.js');
  const origConnect = mod.MachbaseClient.prototype.connect;
  const origClose = mod.MachbaseClient.prototype.close;
  mod.MachbaseClient.prototype.connect = async function() {};
  mod.MachbaseClient.prototype.close = async function() {};
  return () => {
    mod.MachbaseClient.prototype.connect = origConnect;
    mod.MachbaseClient.prototype.close = origClose;
  };
}

function patchTargetWriter(appendFn) {
  const TW = require('../../machbase/target_writer.js');
  const origOpen = TW.prototype.open;
  const origAppend = TW.prototype.append;
  const origClose = TW.prototype.close;
  TW.prototype.open = async function() {
    this.writeColumns = [];
    this.targetColumnNames = ['name', 'time', 'value'];
    this.sourceColumnSet = new Set(['name', 'time', 'value']);
    this.stream = { append: async () => {}, close: async () => {} };
    return null;
  };
  if (appendFn) TW.prototype.append = appendFn;
  TW.prototype.close = async function() { return null; };
  return () => {
    TW.prototype.open = origOpen;
    TW.prototype.append = origAppend;
    TW.prototype.close = origClose;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E-02: SIGKILL 후 재시작 — STARTUP_INTEGRITY가 기존 복제분 skip
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-02: SIGKILL 후 재시작 — STARTUP_INTEGRITY skip 동작', () => {
  test('재시작 시 대상에 이미 존재하는 행은 skipped_exists로 건너뜀', async () => {
    const tmpDir = await makeTmpDir();
    const store = new CheckpointStore(tmpDir);
    const IC = require('../../machbase/integrity_checker.js');

    // 이전 실행에서 _rid 1~3 복제 완료 상태로 체크포인트 저장 (SIGKILL 시뮬레이션)
    await store.save('e2e02', '_TAG_DATA_0', {
      last_success_rid: 1n,  // SIGKILL로 인해 1n만 저장됨 (실제로는 3개 row가 대상에 있음)
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 1, rows_written: 1, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = { value: false };
    const skippedRids = [];
    const writtenRids = [];

    // STARTUP_INTEGRITY: rid=1(time=1000n) → 대상에 존재, rid=2(time=2000n) → 대상에 미존재
    // → safe_cp = 1n, STEADY는 2n부터 시작

    let integrityReadDone = false;
    let steadyBatch = 0;

    const restoreSR = patchSourceReader(async (conn, dt, startRid) => {
      if (!integrityReadDone) {
        integrityReadDone = true;
        // STARTUP_INTEGRITY 배치: 체크포인트(1n)부터 읽기
        return {
          rows: [
            { rid: 1n, tagId: 1, time: 1000n, value: 1.0 }, // 대상에 존재 → skip
            { rid: 2n, tagId: 1, time: 2000n, value: 2.0 }, // 대상에 미존재 → first miss
          ],
          err: null,
        };
      }
      // STEADY 배치: rid=2n부터 새 데이터
      steadyBatch++;
      if (steadyBatch === 1) {
        return {
          rows: [
            { rid: 2n, tagId: 1, time: 2000n, value: 2.0 },
            { rid: 3n, tagId: 1, time: 3000n, value: 3.0 },
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    });

    const restoreMeta = patchTagMeta(
      async function() { this.map = new Map([[1, 'sensor_a']]); this.logicalTable = 'TAG'; },
      async function(conn, tagId) {
        const name = this.map.get(Number(tagId));
        if (!name) return { canonical: null, status: 'drop_not_found' };
        return { canonical: name, status: 'ok' };
      }
    );

    const restoreIC = patchIntegrityChecker(async (conn, table, rows) => {
      const existSet = new Set();
      for (const r of rows) {
        if (r.time === 1000n) {
          // rid=1 row가 대상에 존재
          existSet.add(IC.existKey(r.canonical, r.time));
          skippedRids.push(1n);
        }
      }
      return { existSet, err: null };
    });

    const restoreMC = patchMachbaseClient();

    const restoreTW = patchTargetWriter(async function(rows) {
      for (const r of rows) writtenRids.push(r);
      return null;
    });

    try {
      const TargetWriter = require('../../machbase/target_writer.js');
      await runDataTableWorker({
        jobId: 'e2e02',
        mapping: baseMapping({ integrity: { enabled: true } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      // STARTUP_INTEGRITY: rid=1(time=1000n)은 skip, rid=2(time=2000n)는 first miss
      assert.ok(skippedRids.length >= 1, 'skipped_exists > 0: 기존 복제분이 skip되어야 함');

      // STEADY: rid=2~3 기록
      assert.ok(writtenRids.length >= 2, 'STEADY에서 rid=2,3이 기록되어야 함');

      // 최종 체크포인트: STEADY 배치 처리 후 maxRid(3n)+1n = 4n
      const { cp } = await store.load('e2e02', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 4n, '최종 checkpoint = maxRid(3n) + 1n = 4n');
    } finally {
      restoreSR(); restoreMeta(); restoreIC(); restoreMC(); restoreTW();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-03: SIGTERM graceful — shutdown_timeout_ms 이내 종료, cp 최신 상태
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-03: SIGTERM graceful shutdown', () => {
  test('배치 처리 도중 shutdown_requested=true → 현재 배치 완료 후 종료, cp 갱신', async () => {
    const tmpDir = await makeTmpDir();
    const store = new CheckpointStore(tmpDir);
    const shutdownFlag = { value: false };
    let batchCount = 0;

    const restoreSR = patchSourceReader(async (conn, dt, startRid) => {
      batchCount++;
      if (batchCount === 1) {
        // 첫 번째 배치 반환 (배치 처리 중 shutdown 신호가 올 예정)
        return {
          rows: [
            { rid: 10n, tagId: 1, time: 1000n, value: 1.0 },
            { rid: 11n, tagId: 1, time: 2000n, value: 2.0 },
          ],
          err: null,
        };
      }
      // 두 번째 읽기 시점에 shutdown 신호: 루프 탈출해야 함
      shutdownFlag.value = true;
      return { rows: [], err: null };
    });

    const restoreMeta = patchTagMeta(
      async function() { this.map = new Map([[1, 'sensor_a']]); },
      async function(conn, tagId) {
        const name = this.map.get(Number(tagId));
        if (!name) return { canonical: null, status: 'drop_not_found' };
        return { canonical: name, status: 'ok' };
      }
    );

    const writtenRows = [];
    const restoreTW = patchTargetWriter(async function(rows) {
      writtenRows.push(...rows);
      // append 완료 후 shutdown 신호를 보냄 (배치 처리 중 shutdown 시뮬레이션)
      // 이미 append 호출 중이므로 현재 배치는 완료되어야 함
      return null;
    });

    const startTime = Date.now();

    try {
      const TargetWriter = require('../../machbase/target_writer.js');
      await runDataTableWorker({
        jobId: 'e2e03',
        mapping: baseMapping({ integrity: { enabled: false } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      const elapsed = Date.now() - startTime;

      // 30000ms(shutdown_timeout_ms 기본값) 이내에 종료되어야 함
      assert.ok(elapsed < 30000, `종료 시간(${elapsed}ms)이 shutdown_timeout_ms(30000ms) 이내여야 함`);

      // 첫 번째 배치는 완전히 처리되어 checkpoint가 갱신되어야 함
      const { cp } = await store.load('e2e03', '_TAG_DATA_0');
      assert.ok(cp !== null, 'checkpoint가 저장되어야 함');
      assert.equal(cp.last_success_rid, 12n, '첫 배치 완료 후 cp = maxRid(11n)+1n = 12n');

      // append된 row: 2개 (shutdown이어도 현재 배치는 완료)
      assert.equal(writtenRows.length, 2, '배치 처리 완료: 2개 row가 기록되어야 함');
    } finally {
      restoreSR(); restoreMeta(); restoreTW();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('SLEEP 중 shutdown_requested=true → 즉시 깨어나 종료', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let readCount = 0;

    const restoreSR = patchSourceReader(async () => {
      readCount++;
      if (readCount === 1) {
        // 첫 read: 빈 배치 → SLEEP 진입
        // SLEEP 중 shutdown 신호를 타이머로 설정
        setTimeout(() => { shutdownFlag.value = true; }, 10);
        return { rows: [], err: null };
      }
      return { rows: [], err: null };
    });

    const restoreMeta = patchTagMeta(
      async function() { this.map = new Map(); },
      null
    );
    const restoreTW = patchTargetWriter(null);

    const startTime = Date.now();

    try {
      const TargetWriter = require('../../machbase/target_writer.js');
      await runDataTableWorker({
        jobId: 'e2e03-sleep',
        mapping: baseMapping({ poll_interval_ms: 5000, integrity: { enabled: false } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      const elapsed = Date.now() - startTime;
      // poll_interval_ms=5000ms인데 10ms 후 shutdown → 5000ms 기다리지 않고 즉시 종료해야 함
      assert.ok(elapsed < 500, `SLEEP 중 즉시 깨어나야 함: elapsed=${elapsed}ms (기대 < 500ms)`);
    } finally {
      restoreSR(); restoreMeta(); restoreTW();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-05: LOG 테이블 복제 — STARTUP_INTEGRITY 미수행 확인
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-05: LOG 테이블 복제 — STARTUP_INTEGRITY 미수행', () => {
  test('LOG 테이블 + cp 존재 + integrity.enabled=true → STARTUP_INTEGRITY 미수행, tag_id 변환 없이 기록', async () => {
    const tmpDir = await makeTmpDir();
    const store = new CheckpointStore(tmpDir);

    // 이전 cp 존재
    await store.save('e2e05', 'LOG_TABLE', {
      last_success_rid: 50n,
      source_server: 'src',
      source_table: 'LOG_TABLE',
    }, { rows_read: 10, rows_written: 10, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = { value: false };
    const IC = require('../../machbase/integrity_checker.js');
    const integrityCallCount = { count: 0 };

    let batchCount = 0;
    const restoreSR = patchSourceReader(async (conn, dt, startRid) => {
      batchCount++;
      if (batchCount === 1) {
        // 소스: LOG 데이터 (tag_id가 정수가 아닌 문자열 형태)
        return {
          rows: [
            { rid: 51n, tagId: 'machine_temp', time: 1000n, value: 25.5 },
            { rid: 52n, tagId: 'machine_vibr', time: 2000n, value: 0.3 },
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    });

    const restoreIC = patchIntegrityChecker(async () => {
      integrityCallCount.count++;
      return { existSet: new Set(), err: null };
    });

    const writtenRows = [];
    const restoreTW = patchTargetWriter(async function(rows) {
      writtenRows.push(...rows);
      return null;
    });

    // LOG 테이블은 TagMetaProvider.loadAll을 호출하지 않아야 하므로 patch 불필요
    // (tableType === 'LOG'이면 tagMeta = null)

    try {
      const TargetWriter = require('../../machbase/target_writer.js');
      await runDataTableWorker({
        jobId: 'e2e05',
        mapping: logMapping(),
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: 'LOG_TABLE',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      // STARTUP_INTEGRITY 미수행 확인: IntegrityChecker.batchExists 미호출
      assert.equal(integrityCallCount.count, 0, 'LOG 테이블 → STARTUP_INTEGRITY(batchExists) 미수행');

      // cp=50n에서 시작해 LOG 데이터 그대로 기록
      assert.equal(writtenRows.length, 2, '2개 LOG row가 기록되어야 함');

      // tag_id 변환 없이 NAME에 원본 tagId 그대로 사용
      assert.equal(writtenRows[0].NAME, 'machine_temp', 'LOG: tag_id 변환 없이 NAME에 그대로 사용');
      assert.equal(writtenRows[1].NAME, 'machine_vibr', 'LOG: tag_id 변환 없이 NAME에 그대로 사용');

      // checkpoint 정상 갱신: maxRid(52n)+1n = 53n
      const { cp } = await store.load('e2e05', 'LOG_TABLE');
      assert.equal(cp.last_success_rid, 53n, 'LOG 복제 후 cp = maxRid(52n)+1n = 53n');
    } finally {
      restoreSR(); restoreIC(); restoreTW();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-06: 대상 DB 연결 차단 → retry → 복구 후 자동 재개
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-06: 대상 DB 연결 차단 → retry → 복구 후 자동 재개', () => {
  test('append 첫 호출 실패(retryable) → retry 후 성공, 정상 복제 완료', async () => {
    const tmpDir = await makeTmpDir();
    const store = new CheckpointStore(tmpDir);
    const shutdownFlag = { value: false };

    let batchCount = 0;
    const restoreSR = patchSourceReader(async (conn, dt, startRid) => {
      batchCount++;
      if (batchCount === 1) {
        return {
          rows: [
            { rid: 100n, tagId: 1, time: 5000n, value: 9.9 },
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    });

    const restoreMeta = patchTagMeta(
      async function() { this.map = new Map([[1, 'sensor_x']]); },
      async function(conn, tagId) {
        const name = this.map.get(Number(tagId));
        if (!name) return { canonical: null, status: 'drop_not_found' };
        return { canonical: name, status: 'ok' };
      }
    );

    let appendAttempt = 0;
    const writtenRows = [];
    const restoreTW = patchTargetWriter(async function(rows) {
      appendAttempt++;
      if (appendAttempt === 1) {
        // 첫 번째 append: 연결 차단 시뮬레이션 (retryable 에러)
        const err = new Error('Connection refused');
        err.code = 'ECONNREFUSED';
        return err;
      }
      // 두 번째 append: 복구 후 성공
      writtenRows.push(...rows);
      return null;
    });

    try {
      const TargetWriter = require('../../machbase/target_writer.js');
      await runDataTableWorker({
        jobId: 'e2e06',
        mapping: baseMapping({
          integrity: { enabled: false },
          retry: {
            enabled: true,
            strategy: 'linear',
            initial_delay_ms: 10,
            max_delay_ms: 50,
            multiplier: 1,
            jitter: false,
            max_attempts: 5,
          },
        }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      // 총 2회 append 시도: 1회 실패 → 1회 성공
      assert.equal(appendAttempt, 2, 'append 1회 실패 후 retry → 총 2회 시도');
      assert.equal(writtenRows.length, 1, '최종적으로 1개 row가 기록되어야 함');
      assert.equal(writtenRows[0].NAME, 'sensor_x', '복구 후 정상 기록');

      // checkpoint 정상 갱신
      const { cp } = await store.load('e2e06', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 101n, 'cp = maxRid(100n)+1n = 101n');
    } finally {
      restoreSR(); restoreMeta(); restoreTW();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('retry max_attempts 초과 → mapping skip (Worker 종료)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };

    const restoreSR = patchSourceReader(async () => ({
      rows: [{ rid: 1n, tagId: 1, time: 1000n, value: 1.0 }],
      err: null,
    }));

    const restoreMeta = patchTagMeta(
      async function() { this.map = new Map([[1, 'tag_a']]); },
      async function(conn, tagId) {
        const name = this.map.get(Number(tagId));
        if (!name) return { canonical: null, status: 'drop_not_found' };
        return { canonical: name, status: 'ok' };
      }
    );

    let appendCount = 0;
    const restoreTW = patchTargetWriter(async function(rows) {
      appendCount++;
      // 항상 retryable 에러 반환
      const err = new Error('Connection refused');
      err.code = 'ECONNREFUSED';
      return err;
    });

    try {
      const TargetWriter = require('../../machbase/target_writer.js');
      await runDataTableWorker({
        jobId: 'e2e06-exhaust',
        mapping: baseMapping({
          integrity: { enabled: false },
          retry: {
            enabled: true,
            strategy: 'linear',
            initial_delay_ms: 5,
            max_delay_ms: 20,
            multiplier: 1,
            jitter: false,
            max_attempts: 3, // 3회 초과 시 skip
          },
        }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      // max_attempts=3 → 3회 시도 후 mapping skip (Worker 정상 종료)
      assert.equal(appendCount, 3, 'max_attempts=3 → 3회 append 시도 후 종료');
      assert.equal(shutdownFlag.value, false, 'shutdownFlag는 변경되지 않아야 함');
    } finally {
      restoreSR(); restoreMeta(); restoreTW();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-07: cp 파일 손상 → start_mode 기준 시작, stage="checkpoint_io" 로그
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-07: cp 파일 손상 → start_mode 기준 시작', () => {
  test('JSON 파싱 실패한 cp 파일 → start_mode=full → startRid=0n, stage=checkpoint_io 로그 출력', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeFlag(30);

    // 손상된 cp 파일 직접 생성 (유효하지 않은 JSON)
    const cpFile = path.join(tmpDir, 'e2e07___TAG_DATA_0.json');
    await fs.writeFile(cpFile, '{ broken json !!', 'utf-8');

    // stderr 캡처를 Worker 실행 전에 먼저 설정 (CheckpointStore.load 내부 로그 포함)
    const logs = [];
    const origError = console.error;
    console.error = (...args) => { logs.push(args.join(' ')); };

    const readCalls = [];
    const restoreSR = patchSourceReader(async (conn, dt, startRid) => {
      readCalls.push(startRid);
      return { rows: [], err: null };
    });

    const restoreMeta = patchTagMeta(
      async function() { this.map = new Map(); },
      null
    );
    const restoreTW = patchTargetWriter(null);

    try {
      const TargetWriter = require('../../machbase/target_writer.js');
      await runDataTableWorker({
        jobId: 'e2e07',
        mapping: baseMapping({ start_mode: 'full', integrity: { enabled: false } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      // start_mode=full → startRid=0n으로 시작해야 함
      assert.ok(readCalls.length >= 1, '최소 1회 이상 read 호출');
      assert.equal(readCalls[0], 0n, '파싱 실패 → start_mode=full → startRid=0n');

      // stage="checkpoint_io" 오류 로그가 출력되어야 함
      const cpIoLog = logs.find(l => l.includes('checkpoint_io'));
      assert.ok(cpIoLog !== undefined, 'stage="checkpoint_io" 오류 로그가 출력되어야 함');
    } finally {
      console.error = origError;
      restoreSR(); restoreMeta(); restoreTW();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('source.data_table 불일치 cp 파일 → start_mode=now → startRid=getMaxRid(), stage=checkpoint_io 로그', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeFlag(30);

    // source.data_table이 파일명과 다른 cp 파일 생성 (corruption)
    const cpFile = path.join(tmpDir, 'e2e07b___TAG_DATA_0.json');
    const corruptedCp = {
      version: 1,
      job_id: 'e2e07b',
      source: {
        server: 'src',
        table: 'TAG',
        data_table: '_TAG_DATA_WRONG', // 파일명의 '_TAG_DATA_0'과 불일치
      },
      checkpoint: {
        last_success_rid: '9999',
        updated_at: new Date().toISOString(),
      },
    };
    await fs.writeFile(cpFile, JSON.stringify(corruptedCp), 'utf-8');

    // stderr 캡처를 Worker 실행 전에 먼저 설정
    const logs = [];
    const origError = console.error;
    console.error = (...args) => { logs.push(args.join(' ')); };

    let maxRidCalled = false;
    const readCalls = [];
    const restoreSR = patchSourceReader(
      async (conn, dt, startRid) => {
        readCalls.push(startRid);
        return { rows: [], err: null };
      },
      async () => {
        maxRidCalled = true;
        return { maxRid: 777n, err: null };
      }
    );

    const restoreMeta = patchTagMeta(
      async function() { this.map = new Map(); },
      null
    );
    const restoreTW = patchTargetWriter(null);

    try {
      const TargetWriter = require('../../machbase/target_writer.js');
      await runDataTableWorker({
        jobId: 'e2e07b',
        mapping: baseMapping({ start_mode: 'now', integrity: { enabled: false } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      // data_table 불일치 → cp 무효화 → start_mode=now → getMaxRid() 호출
      assert.ok(maxRidCalled, 'cp 손상 → start_mode=now → getMaxRid() 호출되어야 함');
      assert.ok(readCalls.length >= 1, '최소 1회 read 호출');
      assert.equal(readCalls[0], 777n, 'startRid = getMaxRid() = 777n');

      // stage="checkpoint_io" 오류 로그 확인
      const cpIoLog = logs.find(l => l.includes('checkpoint_io'));
      assert.ok(cpIoLog !== undefined, 'stage="checkpoint_io" 오류 로그가 출력되어야 함');
    } finally {
      console.error = origError;
      restoreSR(); restoreMeta(); restoreTW();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function makeFlag(autoShutdownAfterMs) {
  const flag = { value: false };
  if (autoShutdownAfterMs != null) {
    setTimeout(() => { flag.value = true; }, autoShutdownAfterMs);
  }
  return flag;
}
