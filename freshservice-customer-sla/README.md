# Freshservice Customer SLA Dashboard

A local web app that reports SLA performance **by customer** (Freshservice department) for these selectable periods:

- Last 6 months
- Last 3 months
- Last 60 days
- Last 30 days
- Last 7 days

## Start the app

Requirements: Node.js 18 or newer.

From PowerShell in the project directory, run:

```powershell
npm.cmd start
```

Then open [http://127.0.0.1:3200](http://127.0.0.1:3200). Stop the server with `Ctrl+C`.

You can also double-click `launch-customer-sla.cmd`.

The Freshservice domain and API key are stored in the local `.env` file. That file is excluded by `.gitignore`; the API key is used only by the Node.js backend and is never sent to browser JavaScript.

## How "customer" is defined

Freshservice groups requesters into **departments** (your customer organizations). Each ticket carries a `department_id` sourced from its requester's department. This app pulls `/api/v2/departments` for customer names and attributes every completed ticket to its department.

Tickets with no department appear under **No customer**.

## Measure by: resolution date vs creation date

Use the **Measure by** selector to choose how tickets are counted into a period:

- **Resolution date** (default): a ticket counts when its `resolved_at` or `closed_at` falls inside the range. Best for "how did we perform on work completed in this window."
- **Creation date**: a ticket counts when its `created_at` falls inside the range, whether or not it is resolved yet. Best for "how are tickets opened in this window doing."

The choice is remembered in your browser and recorded in the CSV export. Switching the toggle reuses already-fetched ticket data, so it does not trigger another slow API pull.

## What the dashboard measures

Tickets count in a period based on the selected **Measure by** basis (resolution date by default). Each ticket is attributed to its customer (department).

- **First response SLA:** eligible tickets where `fr_escalated` is false.
- **Resolution SLA:** eligible tickets where `is_escalated` is false.
- **Overall SLA:** eligible tickets where both escalation flags are false.
- **Averages:** Freshservice's first-response and resolution durations when available, with timestamp-based fallback values.
- **MTTR:** Mean time to resolution across completed tickets with available resolution timing data.

Every SLA percentage displays its met/eligible denominator. Customers with no completed tickets remain visible with `N/A` metrics. Use **Export CSV** to download the full per-customer breakdown.

## Operation

- Results are cached separately per period for 15 minutes to limit Freshservice API usage.
- **Refresh data** bypasses the cache.
- API requests retry temporary rate-limit and gateway failures.
- The app listens only on `127.0.0.1` by default.
- Change `PORT` or `HOST` in `.env` if needed. This app defaults to port `3200` so it can run alongside the team dashboard on `3100`.

## Security note

Do not commit `.env`, paste its key into frontend files, or expose this server directly to a network. Rotate your API key if it may have been exposed.

API behavior follows the [official Freshservice API documentation](http://api.freshservice.com/). Content was rephrased for compliance with licensing restrictions.
