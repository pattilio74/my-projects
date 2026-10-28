"""Flask web dashboard for aged Freshdesk tickets."""

from __future__ import annotations

import hmac
import os
import socket
import sys
from datetime import datetime

from flask import Flask, Response, jsonify, redirect, render_template, request, url_for

from .alerts import AlertError, check_and_alert
from .config import Config, ConfigError
from .export import rows_to_csv
from .freshdesk import FreshdeskError
from .scheduler import ensure_scheduler, get_scheduler, start_scheduler
from .tickets import get_aged_tickets


def _auth_ok(auth, user: str, password: str) -> bool:
    """Constant-time check of Basic Auth credentials."""
    if not auth:
        return False
    user_ok = hmac.compare_digest(auth.username or "", user)
    pass_ok = hmac.compare_digest(auth.password or "", password)
    return user_ok and pass_ok


def _lan_ip() -> str:
    """Best-effort primary LAN IPv4 address of this machine.

    Opens a UDP socket to a public address (no packets are actually sent) so the
    OS reveals which local interface it would route through. Falls back to the
    hostname lookup, then localhost.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    return "127.0.0.1"


def build_share_info(config) -> dict:
    """Return the URL and login hint a colleague needs to reach the dashboard."""
    port = getattr(config, "serve_port", 5000) if config else 5000
    host = _lan_ip()
    return {
        "url": f"http://{host}:{port}",
        "host": host,
        "port": port,
        "auth_enabled": bool(config and config.auth_enabled),
        "user": (config.dashboard_user if config and config.auth_enabled else ""),
    }


def _load_config_and_rows(default_config: Config = None):
    """Build config from env, apply ?days override, and fetch aged rows.

    Returns (config, rows). Raises ConfigError / FreshdeskError on failure.
    """
    config = Config.from_env()
    days_override = request.args.get("days", type=int)
    if days_override is not None:
        config.age_threshold_days = days_override
    rows = get_aged_tickets(config)
    return config, rows


def _template_folder() -> str:
    """Locate the templates directory, including inside a PyInstaller bundle.

    When frozen by PyInstaller, bundled data is extracted under sys._MEIPASS.
    We ship the templates there as 'ticket_tracker/templates'. When running
    normally, fall back to the package-relative folder next to this file.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        bundled = os.path.join(meipass, "ticket_tracker", "templates")
        if os.path.isdir(bundled):
            return bundled
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")


def create_app() -> Flask:
    app = Flask(__name__, template_folder=_template_folder())

    @app.before_request
    def require_login():
        """Challenge with HTTP Basic Auth when a dashboard login is configured.

        Credentials are read from the environment on each request so they can be
        changed without restarting. The health check is always public so load
        balancers / uptime monitors can probe it.
        """
        user = os.getenv("DASHBOARD_USER", "").strip()
        password = os.getenv("DASHBOARD_PASSWORD", "")
        if not (user and password):
            return None  # auth not configured; no challenge
        if request.path == "/healthz":
            return None
        if _auth_ok(request.authorization, user, password):
            return None
        return Response(
            "Authentication required.",
            401,
            {"WWW-Authenticate": 'Basic realm="Aged Ticket Dashboard"'},
        )

    @app.route("/")
    def index():
        error = None
        rows = []
        threshold = None
        config = None
        alert_msg = request.args.get("alert")
        try:
            config, rows = _load_config_and_rows()
            threshold = config.age_threshold_days
        except (ConfigError, FreshdeskError) as exc:
            error = str(exc)

        scheduler = get_scheduler()
        scheduler_status = scheduler.status.as_dict() if scheduler else None

        # Build share info even if ticket loading failed, so the Share button
        # still works. Fall back to a config with defaults if env is incomplete.
        share_config = config
        if share_config is None:
            try:
                share_config = Config.from_env()
            except ConfigError:
                share_config = None
        share = build_share_info(share_config)

        # Summary stats for the cards at the top of the page.
        over_3 = sum(1 for r in rows if r.age_days > 3)
        over_7 = sum(1 for r in rows if r.age_days > 7)
        agents_with_aged = len(
            {r.agent for r in rows if r.agent and r.agent != "Unassigned"}
        )
        stats = {
            "over_3": over_3,
            "over_7": over_7,
            "agents_with_aged": agents_with_aged,
        }

        return render_template(
            "index.html",
            rows=[r.as_dict() for r in rows],
            error=error,
            threshold=threshold,
            domain=config.domain if config else None,
            alerts_enabled=config.alerts_enabled if config else False,
            alert_recipient=config.alert_recipient if config else None,
            alert_msg=alert_msg,
            scheduler=scheduler_status,
            share=share,
            stats=stats,
            generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )

    @app.route("/api/tickets")
    def api_tickets():
        try:
            config, rows = _load_config_and_rows()
        except ConfigError as exc:
            return jsonify({"error": str(exc)}), 400
        except FreshdeskError as exc:
            return jsonify({"error": str(exc)}), 502

        return jsonify(
            {
                "threshold_days": config.age_threshold_days,
                "count": len(rows),
                "tickets": [r.as_dict() for r in rows],
            }
        )

    @app.route("/export.csv")
    def export_csv():
        try:
            config, rows = _load_config_and_rows()
        except ConfigError as exc:
            return Response(f"Configuration error: {exc}", status=400, mimetype="text/plain")
        except FreshdeskError as exc:
            return Response(f"Freshdesk error: {exc}", status=502, mimetype="text/plain")

        csv_text = rows_to_csv(rows)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"aged_tickets_{config.age_threshold_days}d_{stamp}.csv"
        return Response(
            csv_text,
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.route("/send-alert", methods=["POST"])
    def send_alert():
        # Preserve any days override when redirecting back.
        days = request.args.get("days", type=int)
        try:
            config, rows = _load_config_and_rows()
            result = check_and_alert(config, rows)
        except (ConfigError, FreshdeskError, AlertError) as exc:
            return redirect(url_for("index", days=days, alert=f"error: {exc}"))

        if result.sent:
            msg = (
                f"Alert sent to {result.recipient} for "
                f"{len(result.new_ticket_numbers)} newly-crossed ticket(s)."
            )
        else:
            msg = result.reason or "No alert sent."
        return redirect(url_for("index", days=days, alert=msg))

    @app.route("/api/scheduler")
    def api_scheduler():
        scheduler = get_scheduler()
        if not scheduler:
            return jsonify({"enabled": False, "status": None})
        return jsonify({"enabled": True, "status": scheduler.status.as_dict()})

    @app.route("/api/share")
    def api_share():
        try:
            config = Config.from_env()
        except ConfigError:
            config = None
        return jsonify(build_share_info(config))

    @app.route("/scheduler/start", methods=["POST"])
    def scheduler_start():
        days = request.args.get("days", type=int)
        try:
            config = Config.from_env()
        except ConfigError as exc:
            return redirect(url_for("index", days=days, alert=f"error: {exc}"))

        scheduler = ensure_scheduler(config)
        if scheduler.status.running:
            msg = "Scheduler already running."
        else:
            scheduler.start()
            msg = f"Scheduler started (every {config.scheduler_interval_minutes} min)."
        return redirect(url_for("index", days=days, alert=msg))

    @app.route("/scheduler/stop", methods=["POST"])
    def scheduler_stop():
        days = request.args.get("days", type=int)
        scheduler = get_scheduler()
        if not scheduler or not scheduler.status.running:
            msg = "Scheduler is not running."
        else:
            scheduler.stop()
            msg = "Scheduler stopped."
        return redirect(url_for("index", days=days, alert=msg))

    @app.route("/healthz")
    def healthz():
        return jsonify({"status": "ok"})

    return app


def main() -> int:
    import logging

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    # Load config for host/port and the scheduler. If it's incomplete (e.g. no
    # Freshdesk credentials yet), still start the server so the dashboard can
    # render the configuration error on the page instead of the process exiting.
    host, port = "127.0.0.1", 5000
    try:
        config = Config.from_env()
        host, port = config.flask_host, config.flask_port
        # Start the built-in scheduler (no-op unless SCHEDULER_ENABLED=true).
        start_scheduler(config)
    except ConfigError as exc:
        logging.warning(
            "Starting with incomplete configuration: %s "
            "The dashboard will show this until .env is filled in.",
            exc,
        )

    app = create_app()
    logging.info("Dashboard starting at http://%s:%s", host, port)
    # Reloader disabled so the background scheduler thread isn't started twice.
    app.run(host=host, port=port, debug=False, use_reloader=False)
    return 0


def serve() -> int:
    """Run the dashboard on a production server (waitress) for sharing.

    Binds to SERVE_HOST/SERVE_PORT (default 0.0.0.0:8080) so colleagues on the
    same network can reach it. Warns loudly if no dashboard login is set while
    bound to a public interface.
    """
    import logging

    from waitress import serve as waitress_serve

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    host, port = "0.0.0.0", 8080
    try:
        config = Config.from_env()
        host, port = config.serve_host, config.serve_port
        start_scheduler(config)
        if not config.auth_enabled and host != "127.0.0.1":
            logging.warning(
                "No dashboard login is set (DASHBOARD_USER / DASHBOARD_PASSWORD) "
                "but the server is bound to %s. Anyone who can reach this address "
                "will see live ticket data. Set both to require a login.",
                host,
            )
        elif config.auth_enabled:
            logging.info("Dashboard login is ENABLED (HTTP Basic Auth).")
    except ConfigError as exc:
        logging.warning(
            "Starting with incomplete configuration: %s "
            "The dashboard will show this until .env is filled in.",
            exc,
        )

    app = create_app()
    logging.info("Serving dashboard on http://%s:%s (Ctrl+C to stop)", host, port)
    waitress_serve(app, host=host, port=port, threads=8)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
