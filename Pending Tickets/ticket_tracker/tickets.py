"""Domain logic: turn raw Freshdesk tickets into aged-ticket rows."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from .config import Config
from .freshdesk import FreshdeskClient

# Freshdesk priority codes -> label
PRIORITY_LABELS = {1: "Low", 2: "Medium", 3: "High", 4: "Urgent"}

# Freshservice status codes -> label (2=Open, 3=Pending, 4=Resolved, 5=Closed)
STATUS_LABELS = {2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed"}
CLOSED_STATUSES = {4, 5}
PENDING_STATUS = 3


@dataclass
class AgedTicket:
    ticket_number: int
    subject: str
    agent: str
    priority: str
    priority_code: int
    status: str
    last_update: str          # human-readable
    last_update_iso: str      # raw ISO timestamp
    age_days: int
    age_display: str
    days_since_update: int    # full days since updated_at
    days_since_update_display: str
    created_at_iso: str

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Parse Freshdesk timestamps like '2024-01-05T12:34:56Z' into aware datetimes."""
    if not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _humanize(dt: Optional[datetime]) -> str:
    if dt is None:
        return "unknown"
    return dt.astimezone().strftime("%Y-%m-%d %H:%M")


def _age_display(days: int) -> str:
    if days == 1:
        return "1 day"
    return f"{days} days"


def _as_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    """Coerce ticket metadata values from JSON into integers when possible."""
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else default
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return default
        try:
            return int(text)
        except ValueError:
            return default
    return default


def build_aged_tickets(
    raw_tickets: List[Dict[str, Any]],
    agent_map: Dict[int, str],
    age_threshold_days: int,
    exclude_closed: bool,
    now: Optional[datetime] = None,
    pending_only: bool = False,
) -> List[AgedTicket]:
    """Filter tickets older than the threshold and shape them into rows.

    Age is measured from the ticket's created_at date. When `pending_only` is
    set, only tickets in Pending status are included.
    """
    now = now or datetime.now(timezone.utc)
    rows: List[AgedTicket] = []

    for t in raw_tickets:
        created = _parse_iso(t.get("created_at"))
        if created is None:
            continue

        age_days = (now - created).days
        if age_days <= age_threshold_days:
            continue

        status_code = t.get("status")
        if pending_only:
            if status_code != PENDING_STATUS:
                continue
        elif exclude_closed and status_code in CLOSED_STATUSES:
            continue

        responder_id = t.get("responder_id")
        agent_name = agent_map.get(responder_id, "Unassigned") if responder_id else "Unassigned"

        priority_code = t.get("priority", 0) or 0
        updated = _parse_iso(t.get("updated_at"))

        # Full days since the ticket was last updated (0 if unknown).
        days_since_update = (now - updated).days if updated is not None else 0

        rows.append(
            AgedTicket(
                ticket_number=t.get("id"),
                subject=t.get("subject") or "(no subject)",
                agent=agent_name,
                priority=PRIORITY_LABELS.get(priority_code, "Unknown"),
                priority_code=priority_code,
                status=STATUS_LABELS.get(status_code, "Unknown"),
                last_update=_humanize(updated),
                last_update_iso=t.get("updated_at") or "",
                age_days=age_days,
                age_display=_age_display(age_days),
                days_since_update=days_since_update,
                days_since_update_display=_age_display(days_since_update),
                created_at_iso=t.get("created_at") or "",
            )
        )

    # Oldest first, then by priority (Urgent first) as a tiebreaker.
    rows.sort(key=lambda r: (-r.age_days, -r.priority_code))
    return rows


def get_aged_tickets(config: Config) -> List[AgedTicket]:
    """High-level entry point: fetch from Freshservice and return aged rows.

    Uses the server-side filter API to pull only tickets created before the
    age cutoff, which is far faster than scanning every ticket. The cutoff is
    the start of the day `age_threshold_days` days ago, so that all tickets
    strictly older than the threshold are captured (build_aged_tickets then
    applies the exact day-based comparison).
    """
    client = FreshdeskClient(config)
    agent_map = client.get_agent_map()

    now = datetime.now(timezone.utc)
    # Filter is inclusive-ish and day-granular, so use a slightly wider window
    # (threshold days back) and let build_aged_tickets do the exact filtering.
    cutoff = (now - timedelta(days=config.age_threshold_days)).strftime("%Y-%m-%d")
    # Only Pending tickets — filtered server-side for speed, then enforced again
    # in build_aged_tickets as a safeguard.
    raw = client.filter_tickets_created_before(cutoff, status=PENDING_STATUS)

    return build_aged_tickets(
        raw_tickets=raw,
        agent_map=agent_map,
        pending_only=True,
        age_threshold_days=config.age_threshold_days,
        exclude_closed=config.exclude_closed,
        now=now,
    )
