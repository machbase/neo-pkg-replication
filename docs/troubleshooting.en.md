---
title: Troubleshooting
weight: 50
---

# Troubleshooting

This document explains likely causes and recommended checks for common symptoms in the Replication UI.

## 1. A Server or Table Cannot Be Selected

### The Source Server Is Missing from the List

Check the following:

1. Confirm that the server is registered in Server Settings.
2. Run a connection test.
3. Confirm that the server type is `native` or `http`.

It is normal for `mqtt-api` and `mqtt-publish` not to appear in the Source list because they are Target-only.

### The Table List Is Empty or a Table Is Missing

Check the following:

1. Confirm that you selected the correct server and Port.
2. Confirm that the connection account can query tables.
3. Confirm that the table exists in the actual database.

The Replication UI lists only local TAG/LOG logical tables. It is normal for tables from a mounted database or backup to be excluded.

If the Target is `mqtt-publish`, a Topic field appears instead of the table list.

## 2. Job Save or Validation Fails

### Save Fails When the Target Is `mqtt-publish`

Check whether the Topic contains a space, `+`, or `#`, or starts or ends with `/`.
In general, use a combination of letters, numbers, `.`, `_`, `-`, and `/`.

### Validation Warnings Appear

Validation Warnings are different from errors that prevent saving. Review the Source/Target mapping and conditions, and select `Save Anyway` if the configuration is intentional.

### An Error Says That Source and Target Are the Same Table

The same physical table in the same Machbase Neo instance cannot be used as both Source and Target. Saving is rejected even if the Server names are different when they refer to the same instance and table.

Change either the Source or Target table, and then save again.

## 3. A Job Cannot Be Registered, Started, Edited, or Deleted

### The Job Was Created but Did Not Start Immediately

The job configuration may exist in a config-only state because service registration did not complete.

1. Check whether a `Register` button appears to the right of the job in the sidebar.
2. Click `Register` to retry service registration.
3. When a switch appears after registration, start the job.

In the normal creation flow, a job is registered and started automatically.

### The Edit or Delete Button Is Disabled

A running job cannot be edited or deleted. Stop the job with the switch in the sidebar, and then try again.

### A Server Cannot Be Deleted

Server deletion is rejected when a job uses that Server as its Source or Target.

1. Check the job shown in the error message.
2. Change the Server setting for that job or delete the job.
3. Try deleting the Server again.

## 4. Less Data Is Replicated Than Expected

Check the following settings:

- Whether `Replication Target Condition` is narrowly set to `IN` or `LIKE`
- Whether a range `filter` is applied in Data Pipeline Builder
- Whether Start Mode is set to `Now` even though an initial full copy is required
- Whether a required Source column is disabled in the Source/Target column mapping

`Now` processes only new data generated after the job is first started. Use `Full` when existing data must also be replicated.

## 5. TAG Metadata Synchronization Is Delayed or Fails

When a TAG table is replicated to a `native` or `http` Target, required TAG metadata is synchronized before its data. Data for that tag may wait until metadata synchronization completes.

Check in this order:

1. Open Live Logs and look for WARN or ERROR messages related to `meta_sync`.
2. Confirm that both Source and Target connections work.
3. Confirm that the Target account can register or update TAG metadata.
4. Confirm that the Source/Target metadata column mapping is intentional.

Replication may pause temporarily while a new tag or a changed tag name and metadata are processed.

## 6. A Warning Appears on the Dashboard

Typical causes include:

- The Source or Target table was removed or changed
- Table row count lookup failed
- A Server connection failed temporarily

First read the warning at the top of the dashboard and confirm that the Source/Target servers and tables still exist. If the error continues, open Live Logs. If you need earlier records, inspect the files in Log Files.

## 7. Live Logs Are Empty or Disconnected

The Live Logs connection starts when the popup opens and ends when it closes.

Check the following:

1. Open the popup with `Live Logs` at the top of the dashboard.
2. Confirm that its connection status is `CONNECTED`.
3. Confirm that the job status is `running`.
4. If logging is paused, click `Resume`.
5. Check whether the log level is set to `WARN` or `ERROR` and very few new logs are being generated.

Live Logs show recent output generated after the connection is established. To review or retain earlier records, open or download a file from Log Files.

## 8. Log Files Grow Too Quickly

Use `INFO` or `WARN` for normal operation, and use `DEBUG` or `TRACE` only when detailed analysis is required.

- The active log file is rotated automatically when it reaches 10MB.
- Reducing `File Limit` reduces the total number of log files retained.
- Log timestamps use the local time zone of the Machbase Neo host.

## 9. Settings Change After Source or Target Is Changed

Related fields may be reset so that settings from the previous schema do not remain after a server or table change.

- Changing a server resets the table selection and column/metadata mapping.
- Changing a table resets the column/metadata mapping.
- Changing the Source table may reset Replication Target Condition and Data Pipeline Builder rules.

After the change, review Table selection, Column Mapping, Replication Target Condition, and Data Pipeline Builder in order.

## Navigation

- [Previous: Monitoring and Logs](./monitoring-and-logs.en.md)
- [Back to Index](./index.en.md)
