const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class FreshserviceError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'FreshserviceError';
    this.status = status;
  }
}

export class FreshserviceClient {
  constructor({ domain, apiKey, timeoutMs = 30_000 }) {
    this.baseUrl = `${domain.replace(/\/+$/, '')}/api/v2`;
    this.authorization = `Basic ${Buffer.from(`${apiKey}:X`).toString('base64')}`;
    this.timeoutMs = timeoutMs;
  }

  async request(pathname, searchParams = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [name, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }

    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          headers: {
            Authorization: this.authorization,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        if (response.ok) return await response.json();

        const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
        if (retryable && attempt < maxAttempts - 1) {
          const retryAfter = Number.parseFloat(response.headers.get('retry-after') || '');
          const delayMs = Number.isFinite(retryAfter)
            ? Math.max(1_000, retryAfter * 1_000)
            : Math.min(16_000, 1_000 * (2 ** attempt));
          await sleep(delayMs);
          continue;
        }

        throw new FreshserviceError(
          `Freshservice request failed with status ${response.status}.`,
          response.status,
        );
      } catch (error) {
        if (error.name === 'AbortError') {
          if (attempt < maxAttempts - 1) {
            await sleep(1_000 * (2 ** attempt));
            continue;
          }
          throw new FreshserviceError('Freshservice request timed out.', 504);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new FreshserviceError('Freshservice request failed after retries.', 502);
  }

  async getAgents() {
    const agents = new Map();
    const perPage = 100;

    for (let page = 1; page <= 100; page += 1) {
      const payload = await this.request('/agents', { page, per_page: perPage });
      const batch = Array.isArray(payload.agents) ? payload.agents : [];
      for (const agent of batch) {
        if (agent.id === null || agent.id === undefined) continue;
        const fullName = [agent.first_name, agent.last_name].filter(Boolean).join(' ').trim();
        agents.set(String(agent.id), fullName || agent.email || `Agent ${agent.id}`);
      }
      if (batch.length < perPage) return agents;
    }

    throw new FreshserviceError('Freshservice agent pagination exceeded 10,000 records.');
  }

  async getGroups() {
    const groups = [];
    const perPage = 100;

    for (let page = 1; page <= 100; page += 1) {
      const payload = await this.request('/groups', { page, per_page: perPage });
      const batch = Array.isArray(payload.groups) ? payload.groups : [];
      groups.push(...batch);
      if (batch.length < perPage) return groups;
    }

    throw new FreshserviceError('Freshservice group pagination exceeded 10,000 records.');
  }

  async getTicketsUpdatedSince(updatedSince) {
    const tickets = [];
    const perPage = 100;
    const since = new Date(updatedSince);
    if (Number.isNaN(since.getTime())) throw new TypeError('updatedSince must be a valid date.');

    for (let page = 1; page <= 500; page += 1) {
      const payload = await this.request('/tickets', {
        updated_since: since.toISOString(),
        include: 'stats',
        page,
        per_page: perPage,
      });
      const batch = Array.isArray(payload.tickets) ? payload.tickets : [];
      tickets.push(...batch);
      if (batch.length < perPage) return tickets;
    }

    throw new FreshserviceError('Freshservice ticket pagination exceeded 50,000 records. Narrow the date range.');
  }
}
