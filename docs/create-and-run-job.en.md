---
title: Create and Run Jobs
weight: 30
---

# Create and Run Jobs

This document explains how to create and run a new replication job.

The main examples in this document assume that **both Source and Target are `native` servers**.  
Other server types can also be selected, but for most users it is easier to start with `native`.

## Create a New Job

Click the `+` button at the top of the left sidebar to open the **New Replication Job** screen.

![Full job creation screen](./images/job-form-overview.png)

## 1. Job Name

Enter the name in the `Job` section.

- It is safest to use letters, numbers, `_`, and `-`.
- The job name cannot be changed after the job is created.

## 2. Source Database / Target Database

Use the Database cards to select the server and table for each side.

### Source Database

- Select the server to read data from.
- The Source list usually shows only `native` and `http`.
- Changing the server resets existing column mapping and meta mapping.
- Changing the table may also reset existing mapping and pipeline rules.

### Target Database

- Select the server to write data to.
- The Target side can use `native`, `http`, `mqtt-api`, and `mqtt-publish`.
- `mqtt-api` and `mqtt-publish` appear only on the Target side.
- If you select a regular DB target, choose the target table.
- If you select `mqtt-publish`, a **Topic** field appears instead of a table selector.

When using `mqtt-publish`, make sure the Topic format is valid.

- It must not contain spaces.
- MQTT wildcards `+` and `#` are not allowed.
- It must not start or end with `/`.
- In most cases, letters, numbers, `.`, `_`, `-`, and `/` are the safest characters to use.

## 3. Column Mapping

In `Column Mapping`, you define how Source columns map to Target columns.

- The same order or same names are not required.
- Only the columns you need can be enabled.
- You can reorder mappings by dragging.
- Warnings or errors may appear if types do not match.

In practice, it is usually best to select the correct Source and Target tables first, and then adjust the mapping.

![Column Mapping screen](./images/job-form-column-mapping.png)

## 4. Replication Target Condition

This section decides **which rows will be replicated**.

Supported conditions are:

- `ALL`
  - Replicates all values.
- `IN`
  - Replicates only the specified list of values.
- `LIKE`
  - Replicates only values that match a pattern.

When using `IN`, you can either enter values directly or select them from the tag selection popup.

## 5. Data Pipeline Builder

In `Data Pipeline Builder`, you can transform values or filter out some rows during replication.

Typical examples include:

- Adding a prefix to a string
- Adding a suffix to a string
- Applying bias / multiplier to numeric values
- Filtering out values outside a numeric range

The condition blocks in this section work together with the key column selected in `Replication Target Condition`.

Things to keep in mind:

- If you change the Source table, pipeline rules may be reset.
- Numeric columns and string columns support different transformation types.

## 6. Execution Settings

This section controls how the job starts and how often it checks for new data.

### Start Mode

- `Full (from RID 0)`
  - Reads everything from the beginning.
- `Now (latest)`
  - Follows only new data from the current point.
- `RID After`
  - Starts after the specified RID.

### On Save Failure

- `Continue`
  - Continues as much as possible even if a save fails.
- `Abort`
  - Stops when a save failure occurs.

### Query Limit

- The maximum number of rows read in one query.

### Poll Interval (ms)

- How often the job checks again for new data.

## 7. Advanced Settings

These are advanced options.

- `Integrity Check`
  - Runs a consistency check during recovery.
- `Retry Max Attempts`
  - Number of retry attempts
- `Retry Base Delay (ms)`
  - Initial retry delay
- `Retry Max Delay (ms)`
  - Maximum retry delay

## 8. Logging Controls

This section controls log retention and log verbosity.

- `Log Level`
  - Choose from TRACE, DEBUG, INFO, WARN, and ERROR
- `File Limit`
  - Number of log files to keep

## 9. Validation During Save

When you save, the system automatically runs dry-run validation.  
If there is an unresolved error, the job cannot be saved. If the issue is not fatal but still requires confirmation, a **Validation Warnings** dialog appears.

In that case, you can choose one of the following:

- `Cancel`
- `Save Anyway`

![Validation Warnings screen](./images/job-form-validation-warnings.png)

## What to Check After Creation

In most cases, replication starts as soon as the job is created, so the next step is to find the new job in the sidebar and select it to check its status.  
Right after creation, the list may be refreshed while the main area still shows another job's details.

Check the following:

1. Confirm that the new job appears in the sidebar list.
2. Click that job to open its detail screen, then confirm that the status shows `running` or `REPLICATING` / `IDLE STATE` on the dashboard.
3. If needed, use the switch to stop or start it again.

If a `Register` button appears, that is closer to an exception case than the normal flow.  
In that case, it is best to check [Troubleshooting](./troubleshooting.en.md) first.

## Edit and Delete

- `Edit`
  - It is safest to edit a job only after it has been stopped.
  - The edit button may be disabled while the job is running.
- `Delete`
  - Removes the job configuration and related state.
  - In general, stop a running job before deleting it.

## Notes

- If you change the Source or Target server, review the mapping again.
- If you change the Source table, review the Data Pipeline Builder rules again.
- It is normal that `mqtt-api` and `mqtt-publish` are not available on the Source side.
- If the Target is `mqtt-publish`, always validate the Topic value carefully.
- `Now` is suitable for following only new incoming data. If you need an initial full copy, use `Full`.
