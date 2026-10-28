"""Configuration loaded from environment variables (and an optional .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv is optional at runtime
    pass


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or invalid."""


def _get_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _get_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


@dataclass
class Config:
    domain: str
    api_key: str
    age_threshold_days: int = 3
    exclude_closed: bool = True
    flask_host: str = "127.0.0.1"
    flask_port: int = 5000

    # --- Email alert settings ---
    alerts_enabled: bool = False
    alert_recipient: str = "alerts@example.com"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_use_tls: bool = True
    alert_state_file: str = ".alerted_tickets.json"

    # --- Built-in scheduler ---
    scheduler_enabled: bool = False
    scheduler_interval_minutes: int = 60

    # --- Sharing: production server + access control ---
    serve_host: str = "0.0.0.0"
    serve_port: int = 8080
    dashboard_user: str = ""
    dashboard_password: str = ""

    @property
    def auth_enabled(self) -> bool:
        """True when a dashboard username and password are both configured."""
        return bool(self.dashboard_user and self.dashboard_password)

    @property
    def base_url(self) -> str:
        return f"https://{self.domain}.freshservice.com/api/v2"

    @property
    def email_from(self) -> str:
        return self.smtp_from or self.smtp_user or self.alert_recipient

    @classmethod
    def from_env(cls) -> "Config":
        domain = os.getenv("FRESHDESK_DOMAIN", "").strip()
        api_key = os.getenv("FRESHDESK_API_KEY", "").strip()

        missing = []
        if not domain:
            missing.append("FRESHDESK_DOMAIN")
        if not api_key:
            missing.append("FRESHDESK_API_KEY")
        if missing:
            raise ConfigError(
                "Missing required environment variables: "
                + ", ".join(missing)
                + ". Copy .env.example to .env and fill it in."
            )

        # Allow the user to paste a full URL by mistake; strip it down.
        domain = (
            domain.replace("https://", "")
            .replace("http://", "")
            .replace(".freshservice.com", "")
            .replace(".freshdesk.com", "")
            .strip("/")
        )

        return cls(
            domain=domain,
            api_key=api_key,
            age_threshold_days=_get_int("AGE_THRESHOLD_DAYS", 3),
            exclude_closed=_get_bool("EXCLUDE_CLOSED", True),
            flask_host=os.getenv("FLASK_HOST", "127.0.0.1").strip() or "127.0.0.1",
            flask_port=_get_int("FLASK_PORT", 5000),
            alerts_enabled=_get_bool("ALERTS_ENABLED", False),
            alert_recipient=os.getenv("ALERT_RECIPIENT", "alerts@example.com").strip()
            or "alerts@example.com",
            smtp_host=os.getenv("SMTP_HOST", "").strip(),
            smtp_port=_get_int("SMTP_PORT", 587),
            smtp_user=os.getenv("SMTP_USER", "").strip(),
            smtp_password=os.getenv("SMTP_PASSWORD", ""),
            smtp_from=os.getenv("SMTP_FROM", "").strip(),
            smtp_use_tls=_get_bool("SMTP_USE_TLS", True),
            alert_state_file=os.getenv("ALERT_STATE_FILE", ".alerted_tickets.json").strip()
            or ".alerted_tickets.json",
            scheduler_enabled=_get_bool("SCHEDULER_ENABLED", False),
            scheduler_interval_minutes=max(1, _get_int("SCHEDULER_INTERVAL_MINUTES", 60)),
            serve_host=os.getenv("SERVE_HOST", "0.0.0.0").strip() or "0.0.0.0",
            serve_port=_get_int("SERVE_PORT", 8080),
            dashboard_user=os.getenv("DASHBOARD_USER", "").strip(),
            dashboard_password=os.getenv("DASHBOARD_PASSWORD", ""),
        )

    def validate_email(self) -> None:
        """Raise ConfigError if email alerts are enabled but misconfigured."""
        if not self.alerts_enabled:
            return
        missing = []
        if not self.smtp_host:
            missing.append("SMTP_HOST")
        if not self.alert_recipient:
            missing.append("ALERT_RECIPIENT")
        if missing:
            raise ConfigError(
                "Email alerts are enabled but missing: " + ", ".join(missing)
            )
