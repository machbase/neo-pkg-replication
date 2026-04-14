# Test Log 2026-04-14 (Curl Round 2)

## Scope

- Package base: `http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin`
- DB: `127.0.0.1:5656`
- Server profile: `local`
- Timer control: command line only
- Other package interactions: `curl`

## Baseline

- `GET /api/server/list.js`: `local` present
- `GET /api/rc/list.js`: empty
- Timers `INPUT_TAG-01` ~ `INPUT_TAG-04`: `STOP`
- Recreated tables:
  - `TAG_DST`
  - `TAG_DST2`
  - `TAG_MDST`
  - `TAG_REAL`
  - `TAG_RDST`

## Helper Script

- File: `cgi-bin/tests/realtime_verify.js`
- Purpose: realtime test reset/count/verification helper used during this test round
- Runtime: `machbase-neo jsh`
- Fixed DB target: `127.0.0.1:5656`
- Fixed physical partitions: `_TAG_REAL_DATA_0` .. `_TAG_REAL_DATA_3`

### Commands

- `machbase-neo jsh cgi-bin/tests/realtime_verify.js reset_real`
  - Drop and recreate `TAG_REAL`, `TAG_RDST`
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js drop_recreate_rdst`
  - Drop and recreate `TAG_RDST` only
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js delete_tag_real`
  - Execute `DELETE FROM TAG_REAL`
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js count TAG_RDST`
  - Return row count of a table
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js max_rids`
  - Return max `_RID` for `_TAG_REAL_DATA_0` .. `_TAG_REAL_DATA_3`
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js expected_after_rid 6299`
  - Return expected row count for `startMode=ridAfter`
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js verify_after_rid 6299`
  - Return JSON verification payload for `startMode=ridAfter`
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js expected_after_cp '{"_TAG_REAL_DATA_0":149,"_TAG_REAL_DATA_1":149,"_TAG_REAL_DATA_2":149,"_TAG_REAL_DATA_3":149}'`
  - Return expected row count after a `startMode=now` checkpoint boundary
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js verify_after_cp '{"_TAG_REAL_DATA_0":149,"_TAG_REAL_DATA_1":149,"_TAG_REAL_DATA_2":149,"_TAG_REAL_DATA_3":149}'`
  - Return JSON verification payload for `startMode=now`
- `machbase-neo jsh cgi-bin/tests/realtime_verify.js verify_real_full`
  - Compare full `TAG_REAL` and `TAG_RDST`, including min/max `_RID` snapshot

## Results

### Dry Run

- Valid `TAG_SRC -> TAG_DST`
  - Response: `{"ok":true,...,"warnings":["VARCHAR length may overflow in target.columns: NAME"]}`
- Valid `TAG_SRC -> TAG_DST2`
  - Response: `{"ok":true,...,"warnings":["VARCHAR length may overflow in target.columns: NAME"]}`
- Valid `TAG_META -> TAG_MDST`
  - Response: `{"ok":true,...,"warnings":["VARCHAR length may overflow in target.columns: NAME"]}`
- Invalid `startMode=ridAfter` without `ridAfter`
  - Response: `{"ok":false,"reason":"ridAfter is required when startMode is ridAfter"}`
- Invalid `logging.level=verbose`
  - Response: `{"ok":false,"reason":"logging.level 'verbose' is not supported"}`
- Invalid missing source primary mapping
  - Response: `{"ok":false,"reason":"columns[0] requires source mapping for target key column 'NAME'"}`
- Invalid missing source column `VALUE`
  - Response: `{"ok":false,"reason":"source.columns[3] 'VALUE' not found"}`

### Static Replication

#### `TAG_SRC -> TAG_DST`

- Result: pass
- `targetCount=800`
- `metaCount=4`
- `mismatchGroups=0`
- Sample verification:

```json
{"targetCount":800,"metaCount":4,"mismatchGroups":0,"samples":[{"NAME":"TAG-01","TIME":"2026-04-08 10:42:02 +0000 UTC","srcSample":[0,0,1,1,1,2,2,2],"dstSample":[0,0,1,1,1,2,2,2],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-01","TIME":"2026-04-08 10:42:13 +0000 UTC","srcSample":[0,0,0,0,1,1,1,1],"dstSample":[0,0,0,0,1,1,1,1],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-02","TIME":"2026-04-08 10:42:15 +0000 UTC","srcSample":[0,0,0,0,0,0,1,1],"dstSample":[0,0,0,0,0,0,1,1],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-08 10:42:16 +0000 UTC","srcSample":[0,0,0,0,0,0,0,0],"dstSample":[0,0,0,0,0,0,0,0],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-08 10:42:19 +0000 UTC","srcSample":[0,0,0,0,1,1,1,1],"dstSample":[0,0,0,0,1,1,1,1],"srcCount":50,"dstCount":50,"match":true}]}
```

#### `TAG_SRC -> TAG_DST2` with `VALUE1/VALUE2` swapped

- Result: pass
- `targetCount=800`
- `mismatchGroups=0`
- Sample verification:

```json
{"targetCount":800,"mismatchGroups":0,"samples":[{"NAME":"TAG-01","TIME":"2026-04-08 10:42:02 +0000 UTC","srcSample":["0:14","0:59","1:59","1:60","1:76","2:12","2:42","2:45"],"dstSample":["0:14","0:59","1:59","1:60","1:76","2:12","2:42","2:45"],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-01","TIME":"2026-04-08 10:42:13 +0000 UTC","srcSample":["0:0","0:4","0:65","0:67","1:1","1:32","1:33","1:56"],"dstSample":["0:0","0:4","0:65","0:67","1:1","1:32","1:33","1:56"],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-02","TIME":"2026-04-08 10:42:15 +0000 UTC","srcSample":["0:2","0:30","0:67","0:77","0:9","0:94","1:20","1:42"],"dstSample":["0:2","0:30","0:67","0:77","0:9","0:94","1:20","1:42"],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-08 10:42:16 +0000 UTC","srcSample":["0:13","0:5","0:59","0:62","0:68","0:73","0:79","0:9"],"dstSample":["0:13","0:5","0:59","0:62","0:68","0:73","0:79","0:9"],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-08 10:42:19 +0000 UTC","srcSample":["0:16","0:2","0:81","0:84","1:0","1:25","1:45","1:54"],"dstSample":["0:16","0:2","0:81","0:84","1:0","1:25","1:45","1:54"],"srcCount":50,"dstCount":50,"match":true}]}
```

#### `TAG_META -> TAG_MDST`

- Result: pass
- `targetCount=800`
- `mismatchGroups=0`
- Metadata rows:

```json
[{"NAME":"TAG-01","EQPID":"EQP01","EQPCNT":2},{"NAME":"TAG-02","EQPID":"EQP02","EQPCNT":2},{"NAME":"TAG-03","EQPID":"EQP03","EQPCNT":5},{"NAME":"TAG-04","EQPID":"EQP04","EQPCNT":7}]
```

- Sample verification:

```json
{"targetCount":800,"mismatchGroups":0,"samples":[{"NAME":"TAG-01","TIME":"2026-04-08 10:14:34 +0000 UTC","srcSample":[4,6,6,8,9,12,16,19],"dstSample":[4,6,6,8,9,12,16,19],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-02","TIME":"2026-04-08 10:14:35 +0000 UTC","srcSample":[2,4,5,6,11,13,14,17],"dstSample":[2,4,5,6,11,13,14,17],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-08 10:14:37 +0000 UTC","srcSample":[0,6,9,10,13,14,14,15],"dstSample":[0,6,9,10,13,14,14,15],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-08 10:14:40 +0000 UTC","srcSample":[0,5,7,9,12,16,16,21],"dstSample":[0,5,7,9,12,16,16,21],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-08 10:15:02 +0000 UTC","srcSample":[9,9,12,15,17,18,21,21],"dstSample":[9,9,12,15,17,18,21,21],"srcCount":50,"dstCount":50,"match":true}]}
```

### Realtime Replication

#### Full mode with timer stop and drain

- Result: pass
- `srcCount=1000`
- `dstCount=1000`
- `mismatchGroups=0`
- Sample verification:

```json
{"title":"full","srcCount":1000,"dstCount":1000,"mismatchGroups":0,"metaCount":4,"samples":[{"NAME":"TAG-01","TIME":"2026-04-14 03:50:58 +0000 UTC","srcSample":[0,1,2,3,5,6,8,9],"dstSample":[0,1,2,3,5,6,8,9],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-02","TIME":"2026-04-14 03:50:58 +0000 UTC","srcSample":[1,3,9,10,10,11,12,12],"dstSample":[1,3,9,10,10,11,12,12],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-14 03:50:58 +0000 UTC","srcSample":[3,10,11,12,13,14,14,15],"dstSample":[3,10,11,12,13,14,14,15],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 03:50:58 +0000 UTC","srcSample":[1,3,6,7,9,10,11,15],"dstSample":[1,3,6,7,9,10,11,15],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 03:51:02 +0000 UTC","srcSample":[2,7,10,12,13,15,15,19],"dstSample":[2,7,10,12,13,15,15,19],"srcCount":50,"dstCount":50,"match":true}]}
```

#### Timer stop, drain, restart, continue

- Result: pass
- First stop/drain: `1750:1750`
- Second stop/drain after restart: `2350:2350`
- Final verification:

```json
{"title":"stop_resume","srcCount":2350,"dstCount":2350,"mismatchGroups":0,"metaCount":4,"samples":[{"NAME":"TAG-01","TIME":"2026-04-14 03:50:58 +0000 UTC","srcSample":[0,1,2,3,5,6,8,9],"dstSample":[0,1,2,3,5,6,8,9],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-01","TIME":"2026-04-14 03:51:12 +0000 UTC","srcSample":[4,5,5,11,12,13,16,16],"dstSample":[4,5,5,11,12,13,16,16],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-02","TIME":"2026-04-14 03:51:12 +0000 UTC","srcSample":[3,6,7,9,9,15,17,17],"dstSample":[3,6,7,9,9,15,17,17],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-14 03:51:12 +0000 UTC","srcSample":[0,3,4,9,15,23,28,28],"dstSample":[0,3,4,9,15,23,28,28],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 03:51:12 +0000 UTC","srcSample":[0,0,2,2,7,9,18,18],"dstSample":[0,0,2,2,7,9,18,18],"srcCount":50,"dstCount":50,"match":true}]}
```

#### `kill -9` and restart recovery

- Result: pass
- `PID_BEFORE=479382`
- `PID_AFTER=479470`
- `srcCount=4050`
- `dstCount=4050`
- `mismatchGroups=0`
- Sample verification:

```json
{"title":"kill_restart","srcCount":4050,"dstCount":4050,"mismatchGroups":0,"metaCount":4,"samples":[{"NAME":"TAG-01","TIME":"2026-04-14 03:50:58 +0000 UTC","srcSample":[0,1,2,3,5,6,8,9],"dstSample":[0,1,2,3,5,6,8,9],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-02","TIME":"2026-04-14 03:50:58 +0000 UTC","srcSample":[1,3,9,10,10,11,12,12],"dstSample":[1,3,9,10,10,11,12,12],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-14 03:50:58 +0000 UTC","srcSample":[3,10,11,12,13,14,14,15],"dstSample":[3,10,11,12,13,14,14,15],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-14 03:51:25 +0000 UTC","srcSample":[2,3,4,4,7,13,14,17],"dstSample":[2,3,4,4,7,13,14,17],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 03:51:25 +0000 UTC","srcSample":[0,0,3,9,11,13,13,17],"dstSample":[0,0,3,9,11,13,13,17],"srcCount":50,"dstCount":50,"match":true}]}
```

#### `startMode=now` while input is active

- Result: pass
- Initial checkpoint boundary:

```json
{"_TAG_REAL_DATA_0":149,"_TAG_REAL_DATA_1":149,"_TAG_REAL_DATA_2":149,"_TAG_REAL_DATA_3":149}
```

- Verification:

```json
{"title":"now_mid","cp":{"_TAG_REAL_DATA_0":149,"_TAG_REAL_DATA_1":149,"_TAG_REAL_DATA_2":149,"_TAG_REAL_DATA_3":149},"expectedCount":800,"dstCount":800,"mismatchGroups":0,"samples":[{"NAME":"TAG-01","TIME":"2026-04-14 03:58:25 +0000 UTC","expectedSample":[3,7,11,12,15,15,20,22],"dstSample":[3,7,11,12,15,15,20,22],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"TAG-02","TIME":"2026-04-14 03:58:25 +0000 UTC","expectedSample":[3,3,5,8,8,11,12,15],"dstSample":[3,3,5,8,8,11,12,15],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-14 03:58:25 +0000 UTC","expectedSample":[0,0,4,4,7,7,8,12],"dstSample":[0,0,4,4,7,7,8,12],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 03:58:25 +0000 UTC","expectedSample":[0,4,5,5,7,10,11,12],"dstSample":[0,4,5,5,7,10,11,12],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 03:58:28 +0000 UTC","expectedSample":[0,0,0,1,1,10,10,13],"dstSample":[0,0,0,1,1,10,10,13],"expectedCount":50,"dstCount":50,"match":true}]}
```

#### `startMode=ridAfter` while input is active

- Result: pass
- Max `_RID` snapshot before start:

```json
{"_TAG_REAL_DATA_0":12599,"_TAG_REAL_DATA_1":12599,"_TAG_REAL_DATA_2":12599,"_TAG_REAL_DATA_3":12599}
```

- `ridAfter=6299`
- Verification:

```json
{"title":"rid_after_mid","ridAfter":"6299","expectedCount":25804,"dstCount":25804,"mismatchGroups":0,"samples":[{"NAME":"TAG-01","TIME":"2026-04-14 04:02:29 +0000 UTC","expectedSample":[79],"dstSample":[79],"expectedCount":1,"dstCount":1,"match":true},{"NAME":"TAG-02","TIME":"2026-04-14 04:02:29 +0000 UTC","expectedSample":[94],"dstSample":[94],"expectedCount":1,"dstCount":1,"match":true},{"NAME":"TAG-03","TIME":"2026-04-14 04:02:29 +0000 UTC","expectedSample":[68],"dstSample":[68],"expectedCount":1,"dstCount":1,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 04:02:29 +0000 UTC","expectedSample":[26],"dstSample":[26],"expectedCount":1,"dstCount":1,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 04:04:41 +0000 UTC","expectedSample":[2,5,5,13,16,19,19,20],"dstSample":[2,5,5,13,16,19,19,20],"expectedCount":50,"dstCount":50,"match":true}]}
```

#### Non-zero `_RID` after source delete

- Result: pass
- After `DELETE FROM TAG_REAL`, new rows resumed from non-zero `_RID`:

```json
{"_TAG_REAL_DATA_0":{"min":12900,"max":13049},"_TAG_REAL_DATA_1":{"min":12900,"max":13049},"_TAG_REAL_DATA_2":{"min":12900,"max":13049},"_TAG_REAL_DATA_3":{"min":12900,"max":13049}}
```

- Verification:

```json
{"title":"nonzero_rid_full","srcCount":600,"dstCount":600,"mismatchGroups":0,"samples":[{"NAME":"TAG-01","TIME":"2026-04-14 04:04:54 +0000 UTC","srcSample":[5,7,10,11,12,13,13,17],"dstSample":[5,7,10,11,12,13,13,17],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-02","TIME":"2026-04-14 04:04:54 +0000 UTC","srcSample":[2,3,3,3,4,6,8,8],"dstSample":[2,3,3,3,4,6,8,8],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-03","TIME":"2026-04-14 04:04:54 +0000 UTC","srcSample":[1,2,4,5,5,18,19,21],"dstSample":[1,2,4,5,5,18,19,21],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 04:04:54 +0000 UTC","srcSample":[2,5,12,21,23,24,26,29],"dstSample":[2,5,12,21,23,24,26,29],"srcCount":50,"dstCount":50,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 04:04:56 +0000 UTC","srcSample":[0,1,3,4,6,7,18,18],"dstSample":[0,1,3,4,6,7,18,18],"srcCount":50,"dstCount":50,"match":true}]}
```

### Realtime Filter And Transform

#### `IN(TAG-01,TAG-03)` + `prefix(I.)`

- Result: pass
- `expectedCount=300`
- Metadata names:

```json
["I.TAG-01","I.TAG-03"]
```

- Verification:

```json
{"title":"in_prefix","expectedCount":300,"dstCount":300,"mismatchGroups":0,"samples":[{"NAME":"I.TAG-01","TIME":"2026-04-14 04:06:23 +0000 UTC","expectedSample":[1,2,3,4,4,9,10,13],"dstSample":[1,2,3,4,4,9,10,13],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"I.TAG-01","TIME":"2026-04-14 04:06:24 +0000 UTC","expectedSample":[0,1,3,8,10,11,17,17],"dstSample":[0,1,3,8,10,11,17,17],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"I.TAG-03","TIME":"2026-04-14 04:06:23 +0000 UTC","expectedSample":[1,2,2,4,6,8,10,14],"dstSample":[1,2,2,4,6,8,10,14],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"I.TAG-03","TIME":"2026-04-14 04:06:24 +0000 UTC","expectedSample":[0,2,3,6,6,7,8,16],"dstSample":[0,2,3,6,6,7,8,16],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"I.TAG-03","TIME":"2026-04-14 04:06:25 +0000 UTC","expectedSample":[0,2,5,6,8,8,9,11],"dstSample":[0,2,5,6,8,8,9,11],"expectedCount":50,"dstCount":50,"match":true}]}
```

#### `LIKE(%01)` + `suffix(.S)`

- Result: pass
- `expectedCount=300`
- Metadata names:

```json
["TAG-01.S"]
```

- Verification:

```json
{"title":"like_suffix","expectedCount":300,"dstCount":300,"mismatchGroups":0,"samples":[{"NAME":"TAG-01.S","TIME":"2026-04-14 04:06:23 +0000 UTC","expectedSample":[1,2,3,4,4,9,10,13],"dstSample":[1,2,3,4,4,9,10,13],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"TAG-01.S","TIME":"2026-04-14 04:06:24 +0000 UTC","expectedSample":[0,1,3,8,10,11,17,17],"dstSample":[0,1,3,8,10,11,17,17],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"TAG-01.S","TIME":"2026-04-14 04:06:29 +0000 UTC","expectedSample":[0,2,2,4,4,24,24,28],"dstSample":[0,2,2,4,4,24,24,28],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"TAG-01.S","TIME":"2026-04-14 04:06:30 +0000 UTC","expectedSample":[1,1,2,2,10,10,17,21],"dstSample":[1,1,2,2,10,10,17,21],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"TAG-01.S","TIME":"2026-04-14 04:06:31 +0000 UTC","expectedSample":[0,1,4,5,7,7,7,10],"dstSample":[0,1,4,5,7,7,7,10],"expectedCount":50,"dstCount":50,"match":true}]}
```

#### `VALUE >= 50` filter

- Result: pass
- `expectedCount=925`
- Metadata names:

```json
["TAG-01","TAG-02","TAG-03","TAG-04"]
```

- Verification:

```json
{"title":"min50","expectedCount":925,"dstCount":925,"mismatchGroups":0,"samples":[{"NAME":"TAG-01","TIME":"2026-04-14 04:06:23 +0000 UTC","expectedSample":[50,51,52,53,55,58,59,60],"dstSample":[50,51,52,53,55,58,59,60],"expectedCount":27,"dstCount":27,"match":true},{"NAME":"TAG-02","TIME":"2026-04-14 04:06:23 +0000 UTC","expectedSample":[52,53,56,57,60,62,62,63],"dstSample":[52,53,56,57,60,62,62,63],"expectedCount":32,"dstCount":32,"match":true},{"NAME":"TAG-03","TIME":"2026-04-14 04:06:23 +0000 UTC","expectedSample":[51,51,52,54,59,61,62,66],"dstSample":[51,51,52,54,59,61,62,66],"expectedCount":22,"dstCount":22,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 04:06:23 +0000 UTC","expectedSample":[51,53,53,57,57,58,60,63],"dstSample":[51,53,53,57,57,58,60,63],"expectedCount":22,"dstCount":22,"match":true},{"NAME":"TAG-04","TIME":"2026-04-14 04:06:38 +0000 UTC","expectedSample":[51,51,52,53,54,55,57,57],"dstSample":[51,51,52,53,54,55,57,57],"expectedCount":25,"dstCount":25,"match":true}]}
```

#### `TAG-02` + `prefix(C.)` + `calc((value + 100) * 2)`

- Result: pass
- `expectedCount=600`
- Metadata names:

```json
["C.TAG-02"]
```

- Verification:

```json
{"title":"calc_tag02","expectedCount":600,"dstCount":600,"mismatchGroups":0,"samples":[{"NAME":"C.TAG-02","TIME":"2026-04-14 04:06:23 +0000 UTC","expectedSample":[206,220,220,228,230,244,246,256],"dstSample":[206,220,220,228,230,244,246,256],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"C.TAG-02","TIME":"2026-04-14 04:06:29 +0000 UTC","expectedSample":[202,206,206,224,228,238,244,244],"dstSample":[202,206,206,224,228,238,244,244],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"C.TAG-02","TIME":"2026-04-14 04:06:36 +0000 UTC","expectedSample":[202,208,216,220,220,224,230,232],"dstSample":[202,208,216,220,220,224,230,232],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"C.TAG-02","TIME":"2026-04-14 04:06:42 +0000 UTC","expectedSample":[208,216,216,216,216,224,226,226],"dstSample":[208,216,216,216,216,224,226,226],"expectedCount":50,"dstCount":50,"match":true},{"NAME":"C.TAG-02","TIME":"2026-04-14 04:06:44 +0000 UTC","expectedSample":[200,204,204,210,212,216,218,228],"dstSample":[200,204,204,210,212,216,218,228],"expectedCount":50,"dstCount":50,"match":true}]}
```
