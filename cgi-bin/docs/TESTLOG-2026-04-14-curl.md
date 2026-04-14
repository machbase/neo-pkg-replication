# Replication Curl Test Log

Date: 2026-04-14
Environment:
- package deploy: `http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin`
- DB: `127.0.0.1:5656`
- timer control: `/home/thlee/machbase-neo/machbase-neo shell ... timer ...`
- all package API tests: `curl`

## Setup

- Added server profile `local`
  - host: `127.0.0.1`
  - port: `5656`
  - user: `SYS`
  - type: `native`
- Reset test tables before each scenario
  - `TAG_DST`
  - `TAG_MDST`
  - `TAG_REAL`
  - `TAG_RDST`

Recreate SQL:

```sql
CREATE TAG TABLE TAG_DST (NAME VARCHAR(80) PRIMARY KEY, TIME DATETIME BASETIME, VALUE INTEGER SUMMARIZED);
CREATE TAG TABLE TAG_MDST (NAME VARCHAR(80) PRIMARY KEY, TIME DATETIME BASETIME, VALUE INTEGER SUMMARIZED) metadata (EQPID VARCHAR(20), EQPCNT SHORT);
CREATE TAG TABLE TAG_REAL (NAME VARCHAR(60) PRIMARY KEY, TIME DATETIME BASETIME, VALUE INTEGER SUMMARIZED);
CREATE TAG TABLE TAG_RDST (NAME VARCHAR(60) PRIMARY KEY, TIME DATETIME BASETIME, VALUE INTEGER SUMMARIZED);
```

## Dry Run

### Valid

1. `TAG_SRC -> TAG_DST`
- source columns: `["NAME","TIME","VALUE2"]`
- target columns: `["NAME","TIME","VALUE"]`
- result: `ok=true`
- warnings:
  - `VARCHAR length may overflow in target.columns: NAME`

2. `TAG_META -> TAG_MDST`
- source columns: `["NAME","TIME","VALUE",null]`
- source meta: `["EQPID","EQPCNT"]`
- target columns: `["NAME","TIME","VALUE",null]`
- target meta: `["EQPID","EQPCNT"]`
- result: `ok=true`
- warnings:
  - `VARCHAR length may overflow in target.columns: NAME`

### Invalid

1. `startMode=ridAfter` with no `ridAfter`
- result: fail
- reason: `ridAfter is required when startMode is ridAfter`

2. `filter min > max`
- result: fail
- reason: `source.transform[0].expr[0] filter min must be <= max`

3. invalid logging level
- result: fail
- reason: `logging.level 'verbose' is not supported`

4. missing source mapping for TAG primary key slot
- result: fail
- reason: `columns[0] requires source mapping for target key column 'NAME'`

## Static Replication

### 1. `TAG_SRC -> TAG_DST`

Config intent:
- source `VALUE2` -> target `VALUE`

Result:
- target rows: `800`
- target metadata rows: `4`
- sample check:
  - source `VALUE2`: floating point values
  - target `VALUE`: integer-truncated values written as expected for target type

### 2. `TAG_META -> TAG_MDST`

Config intent:
- source data column subset
- source meta subset without `EQPNAME`

Result:
- target rows: `800`
- target metadata rows: `4`
- metadata sample:
  - `TAG-01 / EQP01 / 2`
  - `TAG-02 / EQP02 / 2`
  - `TAG-03 / EQP03 / 5`
  - `TAG-04 / EQP04 / 7`

## Realtime Replication

Note:
- verification used timer start/stop only from command line
- package control used `curl`
- for realtime TAG validation, plain logical `count(*)` on `TAG_REAL` was not reliable in this environment
- baseline/count verification used physical `_TAG_REAL_DATA_*` / `_TAG_RDST_DATA_*` row counts or grouped logical counts

### Baseline

Scenario:
- source: `TAG_REAL`
- target: `TAG_RDST`
- `startMode=now`
- no filter
- no transform

Initial observation:
- source physical rows: `1150`
- target physical rows: `1146`
- exactly 4 rows missing

Root cause found during test:
- empty source table returned `MAX(_RID) = NULL`
- runtime converted that to `0n`
- `startMode=now` then started at `1n`
- first `_RID=0` rows were skipped

Fix applied:
- `cgi-bin/src/db/client.js`
- `selectMaxRid()` now returns `-1n` for empty tables

Retest after fix:
- source physical rows: `500`
- target physical rows: `500`
- target metadata rows: `4`
- result: pass

### Filter `IN` + `prefix`

Config:
- `rep_target_cond = NAME IN ('TAG-01', 'TAG-03')`
- transform: `prefix('I.')`

Result:
- source selected rows: `550`
  - `TAG-01 = 250`
  - `TAG-03 = 300`
- target rows:
  - `I.TAG-01 = 250`
  - `I.TAG-03 = 300`
- target metadata rows: `2`
- result: pass

### Filter `LIKE` + `suffix`

Config:
- `rep_target_cond = NAME LIKE '%1'`
- transform: `suffix('.L')`

Result:
- source selected rows for `TAG-01`: `250`
- target rows:
  - `TAG-01.L = 250`
- target metadata rows: `1`
- result: pass

### Numeric Filter

Config:
- `rep_target_cond = ALL`
- transform:
  - `prefix('F.')`
  - `filter(VALUE, min=50)`

Result:
- source rows with `VALUE >= 50`: `247`
- target total rows: `247`
- target rows with `VALUE < 50`: `0`
- target metadata rows: `4`
- result: pass

### Calc

Config:
- `rep_target_cond = NAME IN ('TAG-02')`
- transform:
  - `prefix('CALC_')`
  - `calc(VALUE, bias=100, multiplier=2)`

Result:
- source rows for `TAG-02`: `250`
- target rows:
  - `CALC_TAG-02 = 250`
- target metadata rows: `1`
- multiset comparison:
  - transformed source values `(VALUE + 100) * 2`
  - target `VALUE`
  - mismatch count: `0`
- result: pass

## Final State

- replication service list: empty
- timers:
  - `INPUT_TAG-01` STOP
  - `INPUT_TAG-02` STOP
  - `INPUT_TAG-03` STOP
  - `INPUT_TAG-04` STOP
- tables reset to empty:
  - `TAG_DST`
  - `TAG_MDST`
  - `TAG_REAL`
  - `TAG_RDST`
