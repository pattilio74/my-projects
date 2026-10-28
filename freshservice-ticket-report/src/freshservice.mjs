// Minimal zero-dependency Freshservice API client (Node 18+ built-in fetch).

export class FreshserviceClient {
  /**
   * @param {object} opts
   * @param {string} opts.domain  e.g. "https://yourcompany.freshservice.com"
   * @param {string} opts.apiKey  Freshservice API key
   */
  constructor({ domain, apiKey }) {
    if (!domain) throw new Error("domain is required");
    if (!apiKey) throw new Error("apiKey is required");
    this.baseUrl = domain.replace(/\/+$/, "") + "/api/v2";
    // Freshservice uses Basic auth: API key as username, any string as password.
    this.authHeader = "Basic " + Buffer.from(`${apiKey}:X`).toString("base64");
  }

  async #request(path) {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(url, {
        headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
      });

      // Respect Freshservice rate limiting.
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After")) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Freshservice ${res.status} ${res.statusText} for ${path}\n${body.slice(0, 500)}`);
      }
      return res.json();
    }
    throw new Error(`Rate limit retries exhausted for ${path}`);
  }

  /** Fetch every department (customer). Returns Map<id, name>. */
  async getDepartments() {
    const map = new Map();
    let page = 1;
    for (;;) {
      const data = await this.#request(`/departments?per_page=100&page=${page}`);
      const list = data.departments || [];
      for (const d of list) map.set(d.id, d.name?.trim() || `Department ${d.id}`);
      if (list.length < 100) break;
      page++;
    }
    return map;
  }

  /** Fetch every agent. Returns Map<id, fullName>. */
  async getAgents() {
    const map = new Map();
    let page = 1;
    for (;;) {
      const data = await this.#request(`/agents?per_page=100&page=${page}`);
      const list = data.agents || [];
      for (const a of list) {
        const name = [a.first_name, a.last_name].filter(Boolean).join(" ").trim();
        map.set(a.id, name || a.email || `Agent ${a.id}`);
      }
      if (list.length < 100) break;
      page++;
    }
    return map;
  }

  /** Fetch every group. Returns Map<id, name>. */
  async getGroups() {
    const map = new Map();
    let page = 1;
    for (;;) {
      const data = await this.#request(`/groups?per_page=100&page=${page}`);
      const list = data.groups || [];
      for (const g of list) map.set(g.id, g.name?.trim() || `Group ${g.id}`);
      if (list.length < 100) break;
      page++;
    }
    return map;
  }

  /**
   * Fetch all tickets matching a filter query, following pagination.
   * @param {string} query  Freshservice filter query, e.g. 'status:2'
   */
  async getTicketsByFilter(query) {
    const tickets = [];
    const encoded = encodeURIComponent(`"${query}"`);
    let page = 1;
    let total = Infinity;
    for (;;) {
      const data = await this.#request(`/tickets/filter?query=${encoded}&per_page=100&page=${page}`);
      const list = data.tickets || [];
      if (typeof data.total === "number") total = data.total;
      tickets.push(...list);
      // Stop on a partial page or once we've collected the reported total.
      if (list.length < 100 || tickets.length >= total) break;
      page++;
      if (page > 100) break; // hard safety cap (10k tickets)
    }
    return tickets;
  }

  /**
   * Fetch tickets updated since an ISO timestamp, optionally embedding stats.
   * The bounded window keeps SLA reporting predictable and avoids lifetime scans.
   */
  async getTicketsUpdatedSince(updatedSince, { includeStats = false } = {}) {
    const since = new Date(updatedSince);
    if (Number.isNaN(since.getTime())) throw new Error("updatedSince must be a valid date");

    const tickets = [];
    const maxPages = 500;
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({
        updated_since: since.toISOString(),
        per_page: "100",
        page: String(page),
      });
      if (includeStats) params.set("include", "stats");

      const data = await this.#request(`/tickets?${params}`);
      const list = data.tickets || [];
      tickets.push(...list);
      if (list.length < 100) break;
      if (page >= maxPages) {
        throw new Error(`SLA ticket history exceeds the ${maxPages * 100} ticket safety limit`);
      }
      page++;
    }
    return tickets;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Freshservice ticket status codes, including this tenant's custom active statuses.
export const STATUS = {
  OPEN: 2,
  PENDING: 3,
  WORK_IN_PROGRESS: 8,
  ASSIGNED: 9,
  SCHEDULED: 10,
};
