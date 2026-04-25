---
title: Replication User Manual
weight: 10
---

# Replication User Manual

This document explains how to install the **Machbase Neo Replication package**, configure servers, create replication jobs, check status, and review logs.

## Installation

The left sidebar in Machbase Neo shows the list of available packages.  
Select the Replication package and click the `Install` button to install it.

Installation may take a short time, so wait until it is completed.

![Package installation screen](./images/package-install.png)

## What This Manual Covers

- Package installation
- Server registration and connection checks
- Replication job creation
- Job start, stop, and deletion
- Dashboard status checks
- Log file review
- Common warnings and basic troubleshooting

## Basic Workflow

1. Install the Replication package in Neo.
2. Register the source and target servers.
3. Create a new replication job.
4. Check the job status from the dashboard after creation.
5. If needed, review warnings and log files.

## Screen Layout

- Left sidebar: job list, new job creation, and Server Settings
- Main area: selected job details or the job create/edit form
- Modal windows: server add/edit, log file viewer, tag selection, and warning dialogs

![Replication main screen](./images/dashboard-main.png)

## Documents

- [Server Settings](./server-settings.en.md)
- [Create and Run Jobs](./create-and-run-job.en.md)
- [Monitoring and Logs](./monitoring-and-logs.en.md)
- [Troubleshooting](./troubleshooting.en.md)

## Terms

| Term | Meaning |
| --- | --- |
| Server | Connection information for a Machbase or MQTT target |
| Job | One replication task unit |
| Source | The side data is read from. In most cases, `native` or `http` is used. |
| Target | The side data is written to. `native`, `http`, `mqtt-api`, and `mqtt-publish` are supported. |
| TAG / LOG | Machbase table types |
