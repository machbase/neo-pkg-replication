---
title: Server Settings
weight: 20
---

# Server Settings

Before creating a replication job, you need to register the servers you want to connect to.

This document mainly explains the most common `native` server setup.  
Other server types are also supported, but this manual only summarizes the main restrictions for general users.

## Open Server Settings

Click the `dns` icon at the top of the left sidebar to open the **Server Settings** window.

![Server Settings list screen](./images/server-settings-list.png)

## Recommended Starting Point

If you are using Replication for the first time, it is recommended to register **both Source and Target as `native` servers**.

This is recommended because:

- The setup is the simplest.
- Table lookup and mapping are easier to understand.
- The job creation form and dashboard behavior are easiest to follow.

The examples in this manual are also based on `native`.

## Add a New Server

1. Click **Add Server**.
2. Enter `Name`.
3. Select `native` for `Type`.
4. Enter `IP` and `Port`.
5. Enter the authentication fields required for that server type.
6. If needed, run **Test connection** first.
7. Click **Save**.

![native server registration screen](./images/server-form-native.png)

## Field Descriptions

### Common Fields

- `Name`
  - The name used to identify the server in the UI.
  - This is the name you select as Source or Target in a job.
- `Type`
  - The connection method.
- `IP`
  - The address of the target server.
- `Port`
  - The port of the target server.

### Fields Used by `native`

- `ID`
  - The Machbase account ID.
- `Password`
  - The password for that account.

For basic Source/Target replication, these fields are usually enough.

## Other Server Types

The UI can also show these server types:

- `http`
- `mqtt-api`
- `mqtt-publish`

For general users, the main points are:

- `http`
  - Uses HTTP-based connection.
  - Uses `IP`, `Port`, and `Token`.
- `mqtt-api`
  - Uses MQTT API connection.
  - Requires additional fields such as `Token` and `QoS`.
  - It should be treated as **Target-only**.
- `mqtt-publish`
  - It should also be treated as **Target-only**.
  - It sends data to an MQTT Topic instead of a regular DB table.

In other words, it is best to start with `native` and only choose another type when you need a specific integration.

## Restrictions for Other Server Types

- The Source server list usually shows only `native` and `http`.
- `mqtt-api` and `mqtt-publish` should be treated as Target-only.
- If `mqtt-publish` is selected as the Target, the job form shows a **Topic** field instead of a table selector.
- `http`, `mqtt-api`, and `mqtt-publish` may require more input fields and have different operating conditions than `native`.
- For typical table-to-table replication, `native` is the most straightforward setup.

## Connection Test

Click the cable icon in the server list to test the connection.

- On success: `Connected`
- On failure: an error message appears next to the server name

You can run the test before saving the server, and you can also test an already saved server again later.

## Edit and Delete

- `Edit`
  - Modifies the saved server connection information.
  - When editing an existing server, `Name` and `Type` remain fixed.
  - If you leave the password or token blank, the existing value is kept.
- `Delete`
  - Deletes the server.
  - A server cannot be deleted while it is referenced by a job.
  - Change the job's Source or Target server, or delete the job, and then try again.

## Notes

- For a Source server, it is a good idea to test whether table lookup actually works.
- It is normal that `mqtt-api` and `mqtt-publish` do not appear on the Source side.
- If the Target is `mqtt-publish`, data is sent to a **Topic** instead of a table.
- On the edit screen, existing passwords or tokens are kept even if you do not enter them again.
- It is normal for deletion to be rejected while a server is referenced by a job.

## Navigation

- [Back to Index](./index.en.md)
- [Next: Create and Run Jobs](./create-and-run-job.en.md)
