"""Thin Freshdesk API v2 client.

Thin Freshservice API v2 client.

Only implements what the tracker needs: listing tickets (with pagination)
and mapping responder ids to agent names. Freshservice wraps list responses
in {"tickets": [...]} / {"agents": [...]}.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Iterator, List, Optional

import requests

from .config import Config


class FreshdeskError(RuntimeError):
    """Raised for non-recoverable API errors."""


class FreshdeskClient:
    # Freshdesk allows a maximum of 100 records per page.
    PAGE_SIZE = 100
    # Freshdesk paginates the /tickets endpoint up to 300 pages.
    MAX_PAGES = 300

    def __init__(self, config: Config, session: Optional[requests.Session] = None) -> None:
        self.config = config
        self.session = session or requests.Session()
        # Freshdesk uses basic auth: API key as username, any string as password.
        self.session.auth = (config.api_key, "X")
        self.session.headers.update({"Content-Type": "application/json"})

    # ------------------------------------------------------------------ #
    # Low-level request helper (with basic rate-limit handling)
    # ------------------------------------------------------------------ #
    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> requests.Response:
        url = f"{self.config.base_url}{path}"
        for attempt in range(5):
            resp = self.session.get(url, params=params, timeout=30)

            if resp.status_code == 429:
                # Rate limited: honor Retry-After if present.
                retry_after = int(resp.headers.get("Retry-After", "2"))
                time.sleep(max(retry_after, 1))
                continue

            if resp.status_code == 401:
                raise FreshdeskError(
                    "Authentication failed (401). Check FRESHDESK_API_KEY and FRESHDESK_DOMAIN."
                )
            if resp.status_code == 403:
                raise FreshdeskError(
                    "Access forbidden (403). The API key may lack permission for this resource."
                )
            if resp.status_code >= 400:
                raise FreshdeskError(
                    f"Freshdesk API error {resp.status_code} for {url}: {resp.text[:300]}"
                )
            return resp

        raise FreshdeskError("Exceeded retry attempts due to repeated rate limiting (429).")

    # ------------------------------------------------------------------ #
    # Tickets
    # ------------------------------------------------------------------ #
    def iter_tickets(self, updated_since: Optional[str] = None) -> Iterator[Dict[str, Any]]:
        """Yield every ticket, page by page.

        `updated_since` is an optional ISO-8601 timestamp to limit results
        server-side (Freshdesk returns tickets updated after this time).
        """
        page = 1
        while page <= self.MAX_PAGES:
            params: Dict[str, Any] = {
                "per_page": self.PAGE_SIZE,
                "page": page,
                "order_by": "created_at",
                "order_type": "asc",
            }
            if updated_since:
                params["updated_since"] = updated_since

            resp = self._get("/tickets", params=params)
            # Freshservice wraps the list: {"tickets": [...]}.
            payload = resp.json()
            batch: List[Dict[str, Any]] = payload.get("tickets", []) if isinstance(payload, dict) else payload
            if not batch:
                break

            yield from batch

            if len(batch) < self.PAGE_SIZE:
                break
            page += 1

    def list_tickets(self, updated_since: Optional[str] = None) -> List[Dict[str, Any]]:
        return list(self.iter_tickets(updated_since=updated_since))

    def filter_tickets_created_before(
        self, cutoff_date: str, status: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Return tickets created strictly before `cutoff_date` (YYYY-MM-DD).

        If `status` is given, only tickets in that status are returned (filtered
        server-side). Uses Freshservice's filter API, which does the filtering
        server-side so we don't page through the entire instance. The filter
        endpoint is capped at 10 pages (1000 tickets); that's plenty for an
        aged-ticket view and far faster than scanning every ticket.
        """
        results: List[Dict[str, Any]] = []
        page = 1
        # Freshservice expects the query wrapped in double quotes and URL-encoded.
        # requests handles the encoding when we pass it via params.
        query = f"created_at:<'{cutoff_date}'"
        if status is not None:
            query = f"status:{status} AND {query}"
        while page <= 10:
            params = {"query": f'"{query}"', "per_page": self.PAGE_SIZE, "page": page}
            resp = self._get("/tickets/filter", params=params)
            payload = resp.json()
            batch = payload.get("tickets", []) if isinstance(payload, dict) else payload
            if not batch:
                break
            results.extend(batch)
            if len(batch) < self.PAGE_SIZE:
                break
            page += 1
        return results

    # ------------------------------------------------------------------ #
    # Agents
    # ------------------------------------------------------------------ #
    def get_agent_map(self) -> Dict[int, str]:
        """Return {agent_id: display_name} for all agents."""
        agents: Dict[int, str] = {}
        page = 1
        while page <= self.MAX_PAGES:
            resp = self._get("/agents", params={"per_page": self.PAGE_SIZE, "page": page})
            # Freshservice wraps the list: {"agents": [...]}.
            payload = resp.json()
            batch: List[Dict[str, Any]] = payload.get("agents", []) if isinstance(payload, dict) else payload
            if not batch:
                break
            for agent in batch:
                # Freshservice agents carry name fields at the top level.
                first = (agent.get("first_name") or "").strip()
                last = (agent.get("last_name") or "").strip()
                full = f"{first} {last}".strip()
                name = full or agent.get("email") or f"Agent {agent.get('id')}"
                agents[agent["id"]] = name
            if len(batch) < self.PAGE_SIZE:
                break
            page += 1
        return agents
