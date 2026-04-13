# Issue 1238 Worklog

## Scope

- Server connection profiles under `conf.d/server`
- Replication config schema update
- Column/meta mapping validation and dry-run
- Replication query/transform rewrite
- Metadata insert flow for new TAG names
- Logger policy update
- Deployment sync and curl-based verification

## Progress

### 2026-04-13

- Verified current branch/environment:
  - branch: `issue-1238`
  - deploy path reachable: `http://127.0.0.1:5654/public/neo-pkg-replication`
  - git author configured and commit path available when staged changes exist
- Synced current workspace to deploy path with runtime state preserved:
  - excluded `cgi-bin/conf.d/`, `cgi-bin/data/`, `cgi-bin/run/`, `logs/`
- Initial plan fixed:
  1. server profile CRUD
  2. replication config schema update
  3. dry-run API
  4. runtime query/append/meta rewrite
  5. logger policy
  6. docs/deploy/final verification

## Checkpoints

- 2026-04-13 phase 1
  - Added `server` profile storage under `conf.d/server`
  - Added `api/server.js`, `api/server/list.js`
  - Added `api/rc/dryrun.js`
  - Added shared config normalization/resolution layer for server refs and legacy filter/transform migration
  - Added replication config validation for `columns/meta`, type compatibility, and new transform structure
  - Updated `replication.js` to resolve `source.server` / `target.server` at runtime
  - Updated `api/table/columns.js` path through handler to accept `server` references
  - Deploy verification:
    - `GET /api/server/list`
    - `POST/GET/PUT/DELETE /api/server`
    - `POST /api/table/columns` with `server`
    - `POST /api/rc/dryrun`

- 2026-04-13 phase 2
  - Replaced runtime read loop with `maxRid -> endRid -> read -> transform/map -> metadata insert -> checkpoint=endRid`
  - Removed runtime dependence on `ridRangeSize`
  - Removed runtime `autoCreate` behavior; target must already exist
  - Added query-stage SQL filter generation for `rep_target_cond` and transform `expr.type == filter`
  - Changed TAG source read to resolve primary key ids back to original tag names before transform evaluation
  - Added target TAG metadata insert path for newly seen names
  - Added checkpoint `hasMore` override support
  - Service-start validation now prepares runtime config through the same validation path used by API
  - Deploy verification:
    - created temp server profile `issue1238_local`
    - created temp replicator `issue1238_phase2`
    - `start -> running:true -> checkpoint created -> stop -> delete`
    - deleted temp server profile and confirmed cleanup
