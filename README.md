## Replication

Replication copies data from a source table to a target in near real time.
It is designed for moving selected data between Machbase systems or to MQTT-based targets while keeping replication progress with checkpoints.
You can configure jobs from the web UI, monitor their status from the dashboard, and review logs when you need to check current activity or troubleshoot a problem.

## Key Features

- **Web-based job setup**  
  Create and manage replication jobs from the UI without editing configuration files directly.

- **Independent source and target selection**  
  Choose source and target servers and logical databases separately, including Machbase and supported MQTT-based targets.

- **Flexible schema mapping**  
  Map source columns to different target columns when the table structures do not match exactly.

- **Selective replication**  
  Replicate only the rows you need by applying conditions and simple transformation rules.

- **Operational visibility**  
  Check running status, warnings, row count information, and live logs from the dashboard.

- **Checkpoint-based recovery**  
  Resume replication from the last saved progress point after restart or temporary interruption.
