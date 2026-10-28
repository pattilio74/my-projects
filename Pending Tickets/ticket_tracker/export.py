"""Shared rendering helpers (CSV) used by the CLI and the web app."""

from __future__ import annotations

import csv
import io
from typing import List

from .tickets import AgedTicket

# Column key -> header label. Single source of truth for CSV output.
CSV_COLUMNS = [
    ("ticket_number", "Ticket #"),
    ("subject", "Subject"),
    ("agent", "Agent"),
    ("priority", "Priority"),
    ("status", "Status"),
    ("last_update", "Last Update"),
    ("days_since_update", "Days Since Last Update"),
    ("age_days", "Age (days)"),
    ("created_at_iso", "Created At"),
]


def rows_to_csv(rows: List[AgedTicket]) -> str:
    """Render aged tickets to a CSV string (with header row)."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for _, label in CSV_COLUMNS])
    for r in rows:
        d = r.as_dict()
        writer.writerow([d[key] for key, _ in CSV_COLUMNS])
    return buf.getvalue()
