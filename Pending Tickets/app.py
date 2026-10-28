"""Entry point.

Usage:
    python app.py                     # start the web dashboard (+ scheduler if enabled)
    python app.py --cli               # print aged tickets to the terminal
    python app.py --cli --format csv --days 5
    python app.py --cli --alert       # send email alert for new crossings
    python app.py --scheduler         # run the built-in scheduler loop in the foreground
    python app.py --serve             # production server (waitress) for sharing on the network
"""

import sys


def _run_web() -> int:
    from ticket_tracker.web import main as web_main

    return web_main()


def _run_serve() -> int:
    from ticket_tracker.web import serve as web_serve

    return web_serve()


def _run_cli(argv) -> int:
    from ticket_tracker.cli import main as cli_main

    return cli_main(argv)


def _run_scheduler() -> int:
    import logging

    from ticket_tracker.config import Config, ConfigError
    from ticket_tracker.scheduler import run_foreground

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = Config.from_env()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2
    return run_foreground(config)


def main() -> int:
    argv = sys.argv[1:]
    if argv and argv[0] == "--cli":
        return _run_cli(argv[1:])
    if argv and argv[0] == "--scheduler":
        return _run_scheduler()
    if argv and argv[0] == "--serve":
        return _run_serve()
    return _run_web()


if __name__ == "__main__":
    raise SystemExit(main())
