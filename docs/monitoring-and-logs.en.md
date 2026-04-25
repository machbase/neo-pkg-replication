---
title: Monitoring and Logs
weight: 40
---

# Monitoring and Logs

After a job has started, check its status from the dashboard and review log files when needed.

## Items Shown on the Dashboard

When you select a job, status information appears in the detail area on the right.

Main items to check:

- Job name
- Current status badge
- SOURCE / TARGET server and table
- Checkpoint-based progress information
- Source / target row count
- Partition gap information
- Warning messages
- Logging settings
- Live log tail

![Job detail dashboard screen](./images/dashboard-job-detail.png)

## Status Meanings

The most common states shown in the dashboard and sidebar are:

- `running`
  - The job is running.
- `stopped`
  - The job is stopped.
- `REPLICATING`
  - The job is actively replicating data.
- `IDLE STATE`
  - The job is running, but there is not much new data to process right now.

## Warning Messages

Warnings related to the Source or Target may appear at the top of the dashboard.

Examples include:

- Source table not found
- Target table not found
- Row count lookup failed

During operations, it is usually best to check the warning text first and then check the logs.

## SOURCE / TARGET Row Count

The dashboard may show the current row count for the source and target.

- If a value is shown, it means the current row count of that table.
- If it is empty, that method may not support row count lookup, or the value may be temporarily unavailable.

This is useful when you want to quickly compare the amount of replicated data.

## Live Logs

The **Live Logs** card at the bottom of the dashboard shows the active log for the running job in real time.

This card is in the lower part of the detail screen, so it may not be visible if you only look at the top status cards.  
Scroll down to the Live Logs area when needed.

Characteristics of Live Logs:

- It follows the current active log file for the selected job.
- It does not replay the full history. It mainly shows new lines appended after the connection is established.
- Up to 100 recent lines are kept on the screen.
- The panel may appear empty if the log level is restrictive, such as `WARN` or `ERROR`, or if very few new logs are being produced.

Available actions in the UI:

- `Pause` / `Resume`
- `Clear`
- Connection status check (`CONNECTED` / `DISCONNECTED`)

Live Logs are best for checking current activity, while **Log Files** are better for reviewing or saving older logs.

![Live Logs screen](./images/dashboard-live-logs.png)

## Open Log Files

Click **Log Files** in the Logging Controls area to open the log file list for the current job.

## Log File List

The first view shows the list of log files related to that job.

Typical items shown are:

- File name
- File size
- Download button

If older rotated files exist, they may also appear in the list.

![Log file list screen](./images/log-files-list.png)

## View Log File Contents

After selecting a file, you can view the full log content page by page.

Available actions:

- Previous / next page
- Line wrap
- Reload
- Back
- File download is done from the file list screen

Log level tags are highlighted in the form TRACE, DEBUG, INFO, WARN, and ERROR.

## Recommended Check Order During Operation

If a problem is suspected, the following order is usually helpful:

1. Check whether the job is `running`.
2. Check whether any warning message is shown.
3. Check whether the source / target row count looks reasonable.
4. Check the current activity in Live Logs.
5. If needed, open or download older logs from Log Files.

## Notes

- Live Logs are for checking current activity, while Log Files are for keeping or downloading older logs.
- Live Logs do not replay old history. They are meant to show currently generated log lines.
- If the log level is restrictive, Live Logs may show little or no output.
- If the logs are large, file contents may be split into pages.
- If the log level is set too low, log files may grow quickly.
