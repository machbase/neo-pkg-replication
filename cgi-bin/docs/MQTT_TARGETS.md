# MQTT Target Notes

## Scope

This document summarizes the current constraints and usage of:

- `mqtt-api`
- `mqtt-publish`

These notes describe the current `support-multi-type-connection` behavior.

## Support Matrix

| type | source | target | CGI table/list | CGI table/columns | runtime integrity |
|------|--------|--------|----------------|-------------------|-------------------|
| `mqtt-api` | no | yes | yes | yes | no |
| `mqtt-publish` | no | yes | no | no | no |

## mqtt-api

### Purpose

- Machbase MQTT API based target
- CGI metadata lookup is supported
- runtime replication target is write-only

### Runtime Constraints

- cannot be used as `source`
- startup integrity is disabled
- target-side existence check is not used
- target metadata is not inserted by a separate metadata query
- metadata update for existing tag names is not supported

### Write Behavior

- topic: `db/write/{target.table}`
- payload: Machbase MQTT write payload
- QoS is configurable
- success is treated as MQTT publish ack success
- reply wait is not used for runtime write

### TAG Metadata Behavior

- data and mapped meta columns are included in the same write payload
- when a new target tag name appears, Machbase creates metadata from the append payload
- when the target tag name already exists, metadata values in append payload do not update existing metadata

## mqtt-publish

### Purpose

- generic MQTT sink
- target only
- not assumed to be Machbase

### Runtime Constraints

- cannot be used as `source`
- no target schema lookup
- no startup integrity
- no target-side existence check
- no separate metadata insert/update

### Topic Rule

- publish topic is `target.table.toLowerCase()`
- stored config may keep the original table text, but actual publish uses lowercase

### Payload Rule

Payload is always:

```json
{
  "columns": ["NAME", "TIME", "VALUE", "EQPID", "EQPCNT"],
  "rows": [
    ["TAG-01", "2026-04-08T10:14:34Z", 6.0619770115060145, "EQP01", 2]
  ]
}
```

Rules:

- `columns` follow the final mapped output order
- mapped `null` slots are removed from payload schema
- actual row values that are `null` remain `null`
- mapped metadata columns are included in payload columns/rows

## HTTP vs MQTT Metadata Difference

- `http`
  - metadata is inserted first with `insert metadata`
  - data append is batched through HTTP write
  - because current HTTP TAG append requires the full column count, metadata column slots are included in the append payload and filled with `null`
- `mqtt-api`
  - metadata is not inserted separately
  - mapped metadata columns are sent together with data
- `mqtt-publish`
  - metadata is not inserted separately
  - mapped metadata columns are sent in payload

## Test Method

### mqtt-api

1. create a target TAG table in Machbase
2. register replication with `target.server = mqtt-api`
3. start replication
4. verify:
   - target row count
   - target metadata count
   - sample row equality with source

### mqtt-publish

1. register replication with `target.server = mqtt-publish`
2. choose `target.table` as the publish topic source
3. subscribe with `mosquitto_sub`
4. start replication
5. verify:
   - topic is lowercase
   - payload shape is `{ columns, rows }`
   - first row values match source mapping

Sample subscriber:

```bash
mosquitto_sub -h 127.0.0.1 -p 5653 -t 'rpl/pub/test' -C 1 \
  | jq -c '{columns, rowCount:(.rows|length), firstRow:(.rows[0])}'
```

Observed sample payload:

```json
{
  "columns": ["NAME", "TIME", "VALUE", "EQPID", "EQPCNT"],
  "rowCount": 200,
  "firstRow": ["TAG-01", "2026-04-08T10:14:34Z", 6.0619770115060145, "EQP01", 2]
}
```
