# Freshservice Ticket Report

A local web app that reports active Freshservice tickets by **Open**, **Pending**, **Assigned**, **Work in Progress**, and **Scheduled** status for each customer. Freshservice departments are treated as customers.

## Configure

The app requires Node.js 18 or newer.

1. Copy `.env.example` to `.env`.
2. Set `FRESHSERVICE_API_KEY` in `.env` to a Freshservice API key.
3. Keep `.env` private. It is excluded by `.gitignore`.

## Run the web app

From PowerShell in this directory:

```powershell
npm start
```

Open <http://127.0.0.1:3000>. The server listens only on the local computer.

Alternatively, run `npm run app` to launch the desktop-style browser window, or double-click `Ticket Report.cmd`.

## Report behavior

- Open tickets use Freshservice status `2`.
- Pending tickets use Freshservice status `3`.
- Work in Progress tickets use this tenant's status `8`.
- Assigned tickets use this tenant's status `9`.
- Scheduled tickets use this tenant's status `10`.
- Results are grouped by the ticket's `department_id`.
- The Pending reasons section uses the tenant's `custom_fields.pending` value and includes a `No pending reason` bucket.
- Expanded ticket rows and the per-ticket CSV include each ticket's pending reason.
- Only customers with at least one active ticket in the five reported statuses appear in the table.
- Use **Refresh data** to bypass the 60-second report cache.
- CSV downloads are available for ticket details and per-customer summaries.

## CLI

```powershell
npm run report
npm run csv
npm run json
```
