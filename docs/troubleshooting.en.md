---
title: Troubleshooting
weight: 50
---

# Troubleshooting

This document summarizes common issues you may see in the UI and the recommended checks for each case.

## 1. The Source Server Does Not Appear in the List

Possible causes:

- No server has been registered yet
- The server type cannot be used as a Source

How to check:

1. Open Server Settings.
2. Confirm that the server is actually registered.
3. Confirm that the connection test succeeds.

Note:

- `mqtt-api` and `mqtt-publish` should be treated as Target-only.

## 2. The Table List Is Empty

Possible causes:

- The server connection works, but the account cannot query tables
- The wrong server or port was selected
- The target table has not been created yet

Check in this order:

1. Run the connection test again from Server Settings.
2. Confirm that you selected the correct server.
3. Confirm that the table actually exists in the Source / Target DB.

Note:

- If the Target is `mqtt-publish`, it is normal to see a Topic field instead of a table list.

## 3. Save Fails When the Target Is `mqtt-publish`

Possible cause:

- The Topic format is invalid

How to check:

- Check the Topic value again in Target Database.
- Confirm that it does not contain spaces, `+`, or `#`.
- Confirm that it does not start or end with `/`.
- Try again with only letters, numbers, `.`, `_`, `-`, and `/`.

## 4. Validation Warnings Appear During Save

This dialog is different from a hard save error.  
It means the situation is not necessarily fatal, but it still requires confirmation.

Recommended action:

1. Read the warning message.
2. Review the Source / Target mapping and conditions.
3. If the configuration is still intentional, use `Save Anyway`.

## 5. The Job Was Created but Did Not Start Immediately

Possible causes:

- The job configuration was created, but service registration did not complete
- A temporary install error or environment difference left the job in a config-only state

How to check:

- Check whether a `Register` button appears to the right of the job in the sidebar.
- In general, the job starts right after creation, so if a `Register` button appears, it should be treated as an exception case.
- Click `Register` to try the service registration again.
- After registration, a switch should appear so you can start or stop the job normally.

## 6. Edit or Delete Does Not Work

Possible cause:

- The job is running

Recommended order:

1. Stop the job first.
2. After confirming it is stopped, try Edit or Delete again.

## 7. A Warning Is Shown on the Dashboard

Typical causes:

- The Source table was removed or changed
- The Target table was removed or changed
- The current row count lookup failed

Check in this order:

1. Read the warning message.
2. Confirm that the Source / Target server and table still exist.
3. Check whether the current error continues in Live Logs.
4. If needed, open or download older logs from Log Files.

## 8. Less Data Is Replicated Than Expected

Possible causes:

- `Replication Target Condition` is too narrow
- A filter is applied in Data Pipeline Builder
- `Start Mode` is set to `Now`

Check:

- Which condition was selected: `ALL`, `IN`, or `LIKE`
- Whether a `filter` exists in the pipeline
- Whether `Now` was used when a full initial replication was actually needed

## 9. Too Many Logs Are Generated or Files Grow Too Quickly

Possible causes:

- The log level is set too low
- File Limit is too large

Recommended adjustment:

- For normal operation, start with `INFO` or `WARN`
- Use `DEBUG` or `TRACE` only when needed

## 10. Live Logs Are Empty or Disconnected

Possible causes:

- The job is not running yet
- No new logs are being generated yet
- The log file does not exist yet, or the connection was temporarily interrupted

Check in this order:

1. Confirm that the job status is `running`.
2. Confirm that the connection status at the top of Live Logs is `CONNECTED`.
3. Confirm whether the current job naturally produces very little logging.
4. If needed, check whether existing log files are available in Log Files.

## 11. You Need to Keep or Share Log Files

Recommended method:

1. Open Log Files.
2. Click the download button for the file you need.
3. Use the downloaded file for deeper analysis or for sharing with others.

## 12. Settings Look Different After Changing Source or Target

This behavior may not be abnormal.

Expected screen behavior:

- Changing the server may reset the selected table.
- Changing the table may reset the column mapping.
- Changing the Source table may reset Data Pipeline Builder rules.

So after changing Source or Target, review the following again:

- Table selection
- Column Mapping
- Replication Target Condition
- Data Pipeline Builder

## Quick Checklist for Operators

- Check the server connection test first.
- Then check whether the Source / Target tables exist.
- Then check dashboard warnings and row count.
- Finally, check the log files.

## Navigation

- [Previous: Monitoring and Logs](./monitoring-and-logs.en.md)
- [Back to Index](./index.en.md)
