# Aged Ticket Tracker (Freshdesk)

Tracks Freshdesk tickets older than a configurable age (default **3 days**) and shows:

| Ticket # | Subject | Agent | Priority | Last Update | Age |
|----------|---------|-------|----------|-------------|-----|

It ships with:

- **Web dashboard** (Flask) — a live, auto-refreshing table with CSV export,
  a refresh button, and a send-alert button.
- **CLI** — print the same data as a table, CSV, or JSON; write a CSV file; or
  send an alert.
- **Email alerts** — notify a recipient when tickets cross the age threshold.
- **Built-in scheduler** — run the alert check automatically on a timer.

Data is pulled live from the [Freshdesk API v2](https://developers.freshdesk.com/api/).

---

## 1. Setup

Requires Python 3.9+.

```powershell
# From the project folder
python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

## 2. Configure credentials

Copy the example env file and fill in your details:

```powershell
Copy-Item .env.example .env
```

Then edit `.env`:

```
FRESHDESK_DOMAIN=yourcompany          # the part before .freshdesk.com
FRESHDESK_API_KEY=your_api_key_here   # Profile settings -> "Your API Key"
AGE_THRESHOLD_DAYS=3                  # tickets older than this appear
EXCLUDE_CLOSED=true                   # hide Resolved/Closed tickets
```

> Finding your API key: log into Freshdesk, click your avatar → **Profile Settings**.
> Your API key is shown on the right sidebar.

## 3. Run

### Web dashboard

```powershell
python app.py
```

Open http://127.0.0.1:5000 in your browser. Change the age threshold on the fly
with the input box, or via URL: `http://127.0.0.1:5000/?days=7`.

There is also a JSON endpoint: `http://127.0.0.1:5000/api/tickets`.

### CLI

```powershell
python app.py --cli                      # table
python app.py --cli --format csv         # CSV to stdout
python app.py --cli --format json        # JSON
python app.py --cli --days 5             # override threshold
python app.py --cli --csv-out tickets.csv  # write a CSV file
python app.py --cli --alert              # send email alert for new crossings
```

---

## CSV export

- **Web:** click **Download CSV** on the dashboard, or hit
  `http://127.0.0.1:5000/export.csv` (respects `?days=`).
- **CLI:** `--format csv` prints to stdout, or `--csv-out PATH` writes a file.

The CSV includes ticket number, subject, agent, priority, status, last update,
age in days, and created-at timestamp.

## Email alerts

When a ticket crosses the age threshold, you can send an email to
`alerts@example.com` (configurable via `ALERT_RECIPIENT`).

1. In `.env`, set `ALERTS_ENABLED=true` and fill in the `SMTP_*` values. Example
   for Office 365:
   ```
   ALERTS_ENABLED=true
   ALERT_RECIPIENT=alerts@example.com
   SMTP_HOST=smtp.office365.com
   SMTP_PORT=587
   SMTP_USER=you@example.com
   SMTP_PASSWORD=your_password_or_app_password
   SMTP_USE_TLS=true
   ```
2. Trigger a check:
   - **Web:** click **Send alert** on the dashboard.
   - **CLI:** `python app.py --cli --alert`.

Each alert email lists the newly-crossed tickets and attaches a CSV. Already-alerted
tickets are remembered in `ALERT_STATE_FILE` (`.alerted_tickets.json`) so you won't
get duplicate emails for the same ticket. If a ticket drops below the threshold and
later crosses again, it will alert again.

### Automating the alert check

You have two options:

**Option A — built-in scheduler (recommended).** The app can run the alert check
on a timer by itself, no external cron needed. See the next section.

**Option B — OS scheduler.** Schedule the one-shot `--alert` command. On Windows,
use Task Scheduler to run every hour:

```powershell
# Adjust the path to your project + venv
schtasks /create /sc hourly /tn "FreshdeskAgedAlert" /tr `
  "'C:\path\to\project\.venv\Scripts\python.exe' 'C:\path\to\project\app.py' --cli --alert"
```

## Built-in scheduler

The app can periodically fetch tickets and send alerts on its own.

Enable it in `.env` (email alert settings must also be configured to send mail):

```
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MINUTES=60
```

Then run it one of two ways:

- **Alongside the web dashboard:** just `python app.py`. When
  `SCHEDULER_ENABLED=true`, a background thread runs the check every
  `SCHEDULER_INTERVAL_MINUTES`. The dashboard header shows a green
  "Scheduler on" pill, and the footer shows the last/next run.
- **Standalone (no web server):** `python app.py --scheduler`. This runs the
  loop in the foreground until you press Ctrl+C. This mode runs regardless of
  `SCHEDULER_ENABLED` (it's an explicit request).

### Start/stop from the dashboard

You don't have to edit `.env` to toggle the scheduler while the web app is
running. The toolbar has a **Start scheduler** / **Stop scheduler** button:

- **Start scheduler** creates and starts the background loop on demand, even if
  `SCHEDULER_ENABLED=false`. It picks up the current `SCHEDULER_INTERVAL_MINUTES`.
- **Stop scheduler** halts the loop. It stays stopped until you start it again
  (or restart the app with `SCHEDULER_ENABLED=true`).

`SCHEDULER_ENABLED` only controls whether the scheduler **auto-starts** on boot;
the buttons control it at runtime. The Start button is disabled until email
alerts are configured (`ALERTS_ENABLED=true` + SMTP), since a running scheduler
with no mail transport wouldn't send anything.

> Note: the scheduler lives inside the running process. If you have multiple app
> processes (e.g. web + a separate `--scheduler`), each has its own scheduler;
> the dashboard buttons only control the web app's instance.

The first check runs immediately on start, then repeats on the interval. It
reuses the same duplicate-suppression state as manual alerts, so you won't get
repeat emails for the same ticket. Scheduler status is also available as JSON at
`http://127.0.0.1:5000/api/scheduler`.

---

## How "age" is calculated

Age is the number of full days since the ticket's `created_at` date. A ticket
appears when its age is **greater than** the threshold (so with the default of 3,
tickets that are 4+ days old show up).

## Notes

- The **Agent** column resolves `responder_id` to the agent's name via the
  `/agents` endpoint. Tickets with no assignee show as *Unassigned*.
- Priority codes are mapped: 1=Low, 2=Medium, 3=High, 4=Urgent.
- The client handles Freshdesk pagination (100/page) and rate limiting (HTTP 429).
- `.env` is git-ignored so your API key is never committed.

## Project layout

```
app.py                     # entry point (web or --cli)
requirements.txt
.env.example
ticket_tracker/
  config.py                # env-based configuration (Freshdesk + SMTP)
  freshdesk.py             # Freshdesk API v2 client
  tickets.py               # filtering + row shaping
  export.py                # shared CSV builder
  alerts.py                # email alerts + duplicate-suppression state
  scheduler.py             # built-in background scheduler
  cli.py                   # terminal output, --csv-out, --alert
  web.py                   # Flask app (dashboard, /export.csv, /send-alert, /scheduler/*)
  templates/index.html     # dashboard UI (refresh, CSV, send-alert, start/stop scheduler)
```

## Standalone app (no Python needed)

There's a packaged Windows executable so you (or a colleague) can run the
dashboard without installing Python or setting anything up.

### Using it

1. Copy these two items to any folder:
   - `AgedTicketTracker.exe` (from the `dist` folder)
   - `.env` (create it from `dist/.env.example` and fill in your Freshservice
     domain + API key)
2. Double-click `AgedTicketTracker.exe`.
3. A console window opens and your browser launches to the dashboard
   (default `http://127.0.0.1:8080`). Close the console window to stop the app.

The exe reads the `.env` sitting next to it, so you can change settings (port,
login, alerts, scheduler) without rebuilding — just edit `.env` and relaunch.

To let colleagues connect, set `SERVE_HOST=0.0.0.0` and a `DASHBOARD_USER` /
`DASHBOARD_PASSWORD` in that `.env`, then share `http://<your-lan-ip>:8080`
(the Share button in the dashboard shows the exact URL).

### Rebuilding the exe

From the project folder with the venv active:

```powershell
pip install pyinstaller
pyinstaller --noconfirm --clean AgedTicketTracker.spec
```

The result is `dist\AgedTicketTracker.exe`. The Jinja templates are bundled
inside it; only the external `.env` is read from disk.

> Note: never distribute an exe with your own filled-in `.env` unless you intend
> to share your API key. Ship `.env.example` and let each person add their own.

## Run modes at a glance

```powershell
python app.py                 # web dashboard, dev server (+ scheduler if SCHEDULER_ENABLED)
python app.py --serve         # production server for sharing on the network
python app.py --cli ...       # one-shot terminal output / CSV / alert
python app.py --scheduler     # foreground scheduler loop (Ctrl+C to stop)
```

## Share the dashboard with colleagues

`python app.py` uses Flask's dev server bound to localhost, which is fine for
you alone. To let colleagues open the dashboard in their browsers, use
`--serve`, which runs a production server ([waitress](https://pypi.org/project/waitress/))
bound to your network.

### 1. Set a login (do this before sharing)

The dashboard shows live ticket data, so protect it with a shared login. In
`.env`:

```
DASHBOARD_USER=team
DASHBOARD_PASSWORD=pick-a-strong-shared-password
SERVE_HOST=0.0.0.0
SERVE_PORT=8080
```

`DASHBOARD_USER` + `DASHBOARD_PASSWORD` enable HTTP Basic Auth on every page.
If either is blank, the app runs **without** a login and logs a warning.

### 2. Start the server

```powershell
python app.py --serve
```

It binds to `0.0.0.0:8080` by default (all network interfaces). The console
prints the address it's serving on.

### 3. Find the URL to share

Colleagues connect to your machine's LAN IP, not `127.0.0.1`. Find it with:

```powershell
ipconfig | Select-String IPv4
```

Then share `http://<your-lan-ip>:8080` (for example `http://10.0.4.23:8080`).
They'll be prompted for the username and password you set.

### Notes and gotchas

- **Windows Firewall:** the first time you run `--serve`, Windows may prompt to
  allow Python through the firewall — allow it on private networks. If there's
  no prompt and colleagues can't connect, add an inbound rule for the port:
  ```powershell
  New-NetFirewallRule -DisplayName "Aged Ticket Dashboard" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 8080
  ```
- **Same network only:** this shares over your LAN/VPN. It is not reachable from
  the public internet unless you deliberately set that up (and you'd want HTTPS
  and stronger auth first).
- **Keep it running:** the server runs while the process is open. For an
  always-on shared instance, run it on a machine that stays on (or as a Windows
  service via a tool like NSSM).
- **HTTPS:** Basic Auth sends credentials base64-encoded, not encrypted. On an
  untrusted network, put it behind a reverse proxy (IIS, nginx, Caddy) that
  terminates TLS.
