"""Email alerts for tickets that newly cross the age threshold.

State handling: the set of ticket ids we've already alerted on is persisted to
a small JSON file. On each check we only email tickets whose ids are not yet in
that set, then add them. This prevents duplicate alerts for the same ticket.
Tickets that drop back below the threshold (or get closed) are pruned from the
state so a future re-cross will alert again.
"""

from __future__ import annotations

import json
import os
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import List, Set

from .config import Config
from .export import rows_to_csv
from .tickets import AgedTicket


class AlertError(RuntimeError):
    """Raised when sending an alert fails."""


@dataclass
class AlertResult:
    sent: bool
    new_ticket_numbers: List[int]
    recipient: str
    reason: str = ""


# --------------------------------------------------------------------------- #
# State persistence
# --------------------------------------------------------------------------- #
def _load_state(path: str) -> Set[int]:
    if not os.path.exists(path):
        return set()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return {int(x) for x in data.get("alerted", [])}
    except (json.JSONDecodeError, ValueError, OSError):
        # Corrupt/unreadable state: start fresh rather than crash.
        return set()


def _save_state(path: str, alerted: Set[int]) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"alerted": sorted(alerted)}, fh)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Email composition + sending
# --------------------------------------------------------------------------- #
def _build_message(config: Config, new_rows: List[AgedTicket]) -> EmailMessage:
    msg = EmailMessage()
    count = len(new_rows)
    msg["Subject"] = (
        f"[Freshdesk] {count} ticket{'' if count == 1 else 's'} crossed "
        f"{config.age_threshold_days}-day threshold"
    )
    msg["From"] = config.email_from
    msg["To"] = config.alert_recipient

    lines = [
        f"The following {count} ticket(s) are now older than "
        f"{config.age_threshold_days} days:",
        "",
    ]
    for r in new_rows:
        lines.append(
            f"  #{r.ticket_number}  [{r.priority}]  {r.subject}\n"
            f"       Agent: {r.agent} | Age: {r.age_display} | "
            f"Last update: {r.last_update}"
        )
    lines.append("")
    lines.append("A full CSV of these tickets is attached.")
    msg.set_content("\n".join(lines))

    # Attach the CSV of the newly-crossed tickets.
    csv_text = rows_to_csv(new_rows)
    msg.add_attachment(
        csv_text.encode("utf-8"),
        maintype="text",
        subtype="csv",
        filename="aged_tickets.csv",
    )
    return msg


def _send(config: Config, msg: EmailMessage) -> None:
    try:
        with smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=30) as server:
            server.ehlo()
            if config.smtp_use_tls:
                server.starttls()
                server.ehlo()
            if config.smtp_user:
                server.login(config.smtp_user, config.smtp_password)
            server.send_message(msg)
    except (smtplib.SMTPException, OSError) as exc:
        raise AlertError(f"Failed to send alert email: {exc}") from exc


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def check_and_alert(config: Config, rows: List[AgedTicket]) -> AlertResult:
    """Send an alert for tickets that newly crossed the threshold.

    Returns an AlertResult describing what happened. Safe to call repeatedly;
    it only emails tickets not seen in a prior run.
    """
    if not config.alerts_enabled:
        return AlertResult(sent=False, new_ticket_numbers=[], recipient=config.alert_recipient,
                           reason="Alerts disabled (set ALERTS_ENABLED=true).")

    config.validate_email()

    current_ids = {int(r.ticket_number) for r in rows}
    already = _load_state(config.alert_state_file)

    new_ids = current_ids - already
    new_rows = [r for r in rows if int(r.ticket_number) in new_ids]

    # Persist the current set: add newly-crossed, drop tickets no longer aged.
    updated_state = already & current_ids | new_ids

    if not new_rows:
        # Still persist pruned state so re-crossing later re-alerts.
        _save_state(config.alert_state_file, updated_state)
        return AlertResult(
            sent=False,
            new_ticket_numbers=[],
            recipient=config.alert_recipient,
            reason="No newly-crossed tickets since last check.",
        )

    msg = _build_message(config, new_rows)
    _send(config, msg)
    _save_state(config.alert_state_file, updated_state)

    return AlertResult(
        sent=True,
        new_ticket_numbers=sorted(new_ids),
        recipient=config.alert_recipient,
    )
