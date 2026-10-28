"""Standalone launcher for the Aged Ticket Tracker.

Packaged into a single .exe with PyInstaller. On launch it:
  1. Loads a `.env` file placed next to the executable (so credentials are not
     baked into the binary and can be edited by whoever runs it).
  2. Starts the production web server (waitress) in a background thread.
  3. Opens the dashboard in the default browser.
  4. Stays running until the console window is closed / Ctrl+C.

Run the built exe by double-clicking it. Put a filled-in `.env` in the same
folder first (copy `.env.example`).
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
import webbrowser


def _app_dir() -> str:
    """Directory the exe (or script) lives in — where we look for .env."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _load_env_next_to_exe() -> None:
    """Load .env from the exe's folder before anything reads config."""
    env_path = os.path.join(_app_dir(), ".env")
    try:
        from dotenv import load_dotenv

        if os.path.exists(env_path):
            load_dotenv(env_path)
    except ImportError:
        pass


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    _load_env_next_to_exe()

    # Import after env is loaded so Config picks it up.
    from ticket_tracker.config import Config, ConfigError
    from ticket_tracker.scheduler import start_scheduler
    from ticket_tracker.web import create_app

    host, port = "127.0.0.1", 8080
    auth_note = ""
    try:
        config = Config.from_env()
        # For a local desktop launch, prefer localhost unless the user
        # explicitly bound elsewhere via SERVE_HOST.
        host = config.serve_host if config.serve_host not in ("", "0.0.0.0") else "127.0.0.1"
        port = config.serve_port
        start_scheduler(config)
        if not config.auth_enabled:
            auth_note = " (no login set — see .env)"
    except ConfigError as exc:
        logging.warning(
            "Incomplete configuration: %s The dashboard will show this until "
            ".env (next to the exe) is filled in.",
            exc,
        )

    # The browser should open to a reachable address even if bound to 0.0.0.0.
    browse_host = "127.0.0.1" if host in ("0.0.0.0", "") else host
    url = f"http://{browse_host}:{port}"

    app = create_app()

    from waitress import serve as waitress_serve

    def _run_server():
        # Bind to the configured host (localhost by default for the desktop app).
        waitress_serve(app, host=host, port=port, threads=8)

    server_thread = threading.Thread(target=_run_server, name="web-server", daemon=True)
    server_thread.start()

    # Give the server a moment, then open the browser.
    time.sleep(1.5)
    logging.info("Aged Ticket Tracker running at %s%s", url, auth_note)
    logging.info("Close this window to stop the app.")
    try:
        webbrowser.open(url)
    except Exception:  # pragma: no cover - browser is best-effort
        pass

    # Keep the main thread alive while the daemon server runs.
    try:
        while server_thread.is_alive():
            server_thread.join(timeout=1)
    except KeyboardInterrupt:
        logging.info("Shutting down.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
