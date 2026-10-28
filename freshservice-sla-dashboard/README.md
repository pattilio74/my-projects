# Freshservice Team SLA Dashboard

A separate, local web app that reports SLA performance by Freshservice group for these selectable periods:

- Last 6 months
- Last 3 months
- Last 60 days
- Last 30 days
- Last 7 days
- Last 24 hours

## Start the app

Requirements: Node.js 18 or newer.

From PowerShell in the project directory, run:

```powershell
npm.cmd start
```

Then open [http://127.0.0.1:3100](http://127.0.0.1:3100). Stop the server with `Ctrl+C`.

The supplied Freshservice domain and API key are stored in the local `.env` file. That file is excluded by `.gitignore`; the API key is used only by the Node.js backend and is never sent to browser JavaScript.

## What the dashboard measures

Tickets count in a period when their Freshservice `resolved_at` or `closed_at` statistic falls inside the selected range. Each ticket is attributed to its current Freshservice group.

- **First response SLA:** eligible tickets where `fr_escalated` is false.
- **Resolution SLA:** eligible tickets where `is_escalated` is false.
- **Overall SLA:** eligible tickets where both escalation flags are false.
- **Averages:** Freshservice's first-response and resolution durations when available, with timestamp-based fallback values.
- **MTTR:** Mean time to resolution across completed tickets with available resolution timing data.
- **Technicians:** Each team includes current ticket responders with their own SLA, completed-ticket, response-time, and MTTR results.

Every SLA percentage displays its met/eligible denominator. Groups with no completed tickets remain visible with `N/A` metrics.

## Operation

- Results are cached separately per period for 15 minutes to limit Freshservice API usage.
- **Refresh data** bypasses the cache.
- API requests retry temporary rate-limit and gateway failures.
- The app listens only on `127.0.0.1` by default.
- Change `PORT` or `HOST` in `.env` if needed.

## Security note

Do not commit `.env`, paste its key into frontend files, or expose this server directly to a network. Rotate your API key if it may have been exposed.

API behavior follows the [official Freshservice API documentation](http://api.freshservice.com/). Content was rephrased for compliance with licensing restrictions.
