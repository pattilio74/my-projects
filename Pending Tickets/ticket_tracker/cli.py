"""Command-line interface: print aged tickets as a table (or CSV/JSON).

Also supports writing a CSV file (--csv-out) and sending an email alert
(--alert) for tickets that newly crossed the age threshold.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List

from .alerts import AlertError, check_and_alert
from .config import Config, ConfigError
from .export import rows_to_csv
from .freshdesk import FreshdeskError
from .tickets import AgedTicket, get_aged_tickets

# Compact columns for the terminal table view.
TABLE_COLUMNS = [
    ("ticket_number", "Ticket #"),
    ("subject", "Subject"),
    ("agent", "Agent"),
    ("priority", "Priority"),
    ("last_update", "Last Update"),
    ("age_display", "Age"),
]


def _render_table(rows: List[AgedTicket], max_subject: int = 45) -> str:
    data = []
    for r in rows:
        d = r.as_dict()
        subject = str(d["subject"])
        if len(subject) > max_subject:
            subject = subject[: max_subject - 1] + "\u2026"
        d["subject"] = subject
        data.append(d)

    headers = [label for _, label in TABLE_COLUMNS]
    widths = [len(h) for h in headers]
    for d in data:
        for i, (key, _) in enumerate(TABLE_COLUMNS):
            widths[i] = max(widths[i], len(str(d[key])))

    def fmt_row(values):
        return "  ".join(str(v).ljust(widths[i]) for i, v in enumerate(values))

    lines = [fmt_row(headers), fmt_row(["-" * w for w in widths])]
    for d in data:
        lines.append(fmt_row([d[key] for key, _ in TABLE_COLUMNS]))
    return "\n".join(lines)


def _render_json(rows: List[AgedTicket]) -> str:
    return json.dumps([r.as_dict() for r in rows], indent=2)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="ticket-tracker",
        description="Track Freshdesk tickets older than N days.",
    )
    parser.add_argument(
        "--format",
        choices=["table", "csv", "json"],
        default="table",
        help="Output format (default: table).",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=None,
        help="Override the age threshold in days (default from AGE_THRESHOLD_DAYS or 3).",
    )
    parser.add_argument(
        "--csv-out",
        metavar="PATH",
        default=None,
        help="Write the aged tickets to a CSV file at PATH.",
    )
    parser.add_argument(
        "--alert",
        action="store_true",
        help="Send an email alert for tickets that newly crossed the threshold "
        "(requires ALERTS_ENABLED and SMTP settings).",
    )
    args = parser.parse_args(argv)

    try:
        config = Config.from_env()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    if args.days is not None:
        config.age_threshold_days = args.days

    try:
        rows = get_aged_tickets(config)
    except FreshdeskError as exc:
        print(f"Freshdesk error: {exc}", file=sys.stderr)
        return 1

    # Write CSV file if requested (independent of the console format).
    if args.csv_out:
        try:
            with open(args.csv_out, "w", encoding="utf-8", newline="") as fh:
                fh.write(rows_to_csv(rows))
            print(f"Wrote {len(rows)} ticket(s) to {args.csv_out}")
        except OSError as exc:
            print(f"Could not write CSV to {args.csv_out}: {exc}", file=sys.stderr)
            return 1

    # Console output.
    if not rows:
        print(f"No tickets older than {config.age_threshold_days} days. \U0001F389")
    elif args.format == "csv":
        print(rows_to_csv(rows).strip())
    elif args.format == "json":
        print(_render_json(rows))
    else:
        print(
            f"Tickets older than {config.age_threshold_days} days "
            f"({len(rows)} found):\n"
        )
        print(_render_table(rows))

    # Email alert if requested.
    if args.alert:
        try:
            result = check_and_alert(config, rows)
        except (ConfigError, AlertError) as exc:
            print(f"Alert error: {exc}", file=sys.stderr)
            return 1
        if result.sent:
            print(
                f"\nAlert emailed to {result.recipient} for "
                f"{len(result.new_ticket_numbers)} newly-crossed ticket(s): "
                f"{result.new_ticket_numbers}"
            )
        else:
            print(f"\nNo alert sent: {result.reason}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
