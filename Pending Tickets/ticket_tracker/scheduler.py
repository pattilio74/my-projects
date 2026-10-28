"""Built-in background scheduler.

Runs the aged-ticket fetch + email-alert check on a fixed interval in a daemon
thread, so the app can alert on its own without an external cron / Task
Scheduler. Errors in a run are captured and logged but never kill the loop.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from .alerts import AlertError, check_and_alert
from .config import Config, ConfigError
from .freshdesk import FreshdeskError
from .tickets import get_aged_tickets

logger = logging.getLogger("ticket_tracker.scheduler")


@dataclass
class SchedulerStatus:
    running: bool = False
    interval_minutes: int = 60
    last_run_at: Optional[datetime] = None
    last_run_ok: Optional[bool] = None
    last_run_message: str = ""
    last_alert_count: int = 0
    next_run_at: Optional[datetime] = None
    total_runs: int = 0

    def as_dict(self) -> dict:
        def iso(dt: Optional[datetime]) -> Optional[str]:
            return dt.isoformat(timespec="seconds") if dt else None

        return {
            "running": self.running,
            "interval_minutes": self.interval_minutes,
            "last_run_at": iso(self.last_run_at),
            "last_run_ok": self.last_run_ok,
            "last_run_message": self.last_run_message,
            "last_alert_count": self.last_alert_count,
            "next_run_at": iso(self.next_run_at),
            "total_runs": self.total_runs,
        }


class AlertScheduler:
    """A single background scheduler instance."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.interval = timedelta(minutes=config.scheduler_interval_minutes)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self.status = SchedulerStatus(
            interval_minutes=config.scheduler_interval_minutes
        )

    # ------------------------------------------------------------------ #
    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return  # already running
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run_loop, name="alert-scheduler", daemon=True
            )
            self.status.running = True
            self.status.next_run_at = datetime.now()  # first run is immediate
            self._thread.start()
            logger.info(
                "Scheduler started (interval=%s min).",
                self.config.scheduler_interval_minutes,
            )

    def stop(self, timeout: float = 5.0) -> None:
        with self._lock:
            self._stop.set()
            thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=timeout)
        self.status.running = False
        self.status.next_run_at = None
        logger.info("Scheduler stopped.")

    def run_once(self) -> None:
        """Run a single fetch + alert cycle, updating status."""
        self.status.last_run_at = datetime.now()
        self.status.total_runs += 1
        try:
            # Re-read config each run so .env changes are picked up on restart,
            # but reuse the recipient/threshold from the running config.
            rows = get_aged_tickets(self.config)
            result = check_and_alert(self.config, rows)
            self.status.last_run_ok = True
            if result.sent:
                self.status.last_alert_count = len(result.new_ticket_numbers)
                self.status.last_run_message = (
                    f"Alerted {result.recipient} about "
                    f"{len(result.new_ticket_numbers)} new ticket(s)."
                )
                logger.info(self.status.last_run_message)
            else:
                self.status.last_alert_count = 0
                self.status.last_run_message = result.reason or "No alert needed."
                logger.info("Scheduler run: %s", self.status.last_run_message)
        except (ConfigError, FreshdeskError, AlertError) as exc:
            self.status.last_run_ok = False
            self.status.last_run_message = str(exc)
            logger.warning("Scheduler run failed: %s", exc)

    # ------------------------------------------------------------------ #
    def _run_loop(self) -> None:
        # First run immediately, then wait for the interval each cycle.
        while not self._stop.is_set():
            self.run_once()
            self.status.next_run_at = datetime.now() + self.interval
            # Wait returns True if stopped early; sleep in the interval.
            interrupted = self._stop.wait(self.interval.total_seconds())
            if interrupted:
                break


# --------------------------------------------------------------------------- #
# Module-level singleton so the web app shares one scheduler.
# --------------------------------------------------------------------------- #
_scheduler: Optional[AlertScheduler] = None
_singleton_lock = threading.Lock()


def get_scheduler(config: Optional[Config] = None) -> Optional[AlertScheduler]:
    """Return the shared scheduler, creating it if a config is provided."""
    global _scheduler
    with _singleton_lock:
        if _scheduler is None and config is not None:
            _scheduler = AlertScheduler(config)
        return _scheduler


def start_scheduler(config: Config) -> Optional[AlertScheduler]:
    """Create (if needed) and start the shared scheduler. No-op if disabled.

    Used for auto-start on app boot, which respects SCHEDULER_ENABLED.
    """
    if not config.scheduler_enabled:
        logger.info("Scheduler disabled (SCHEDULER_ENABLED=false).")
        return None
    scheduler = get_scheduler(config)
    if scheduler:
        scheduler.start()
    return scheduler


def ensure_scheduler(config: Config) -> AlertScheduler:
    """Return the shared scheduler, creating it on demand.

    Unlike start_scheduler(), this ignores SCHEDULER_ENABLED and does not start
    the loop; it's used by the runtime start/stop controls so the dashboard can
    toggle the scheduler even when auto-start is off. If the scheduler already
    exists but is not running, its interval is refreshed from the given config
    so changes to SCHEDULER_INTERVAL_MINUTES take effect on the next start.
    """
    scheduler = get_scheduler(config)  # creates it if none exists yet
    if not scheduler.status.running:
        scheduler.config = config
        scheduler.interval = timedelta(minutes=config.scheduler_interval_minutes)
        scheduler.status.interval_minutes = config.scheduler_interval_minutes
    return scheduler


def run_foreground(config: Config) -> int:
    """Run the scheduler loop in the foreground (blocking) until Ctrl+C.

    Ignores SCHEDULER_ENABLED so `--scheduler` always runs; it's an explicit
    request to run the loop.
    """
    import time

    scheduler = AlertScheduler(config)
    scheduler.start()
    logger.info(
        "Foreground scheduler running every %s minute(s). Press Ctrl+C to stop.",
        config.scheduler_interval_minutes,
    )
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Interrupted; stopping scheduler...")
        scheduler.stop()
    return 0
