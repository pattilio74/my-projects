const PERIODS = Object.freeze({
  '24h': { key: '24h', label: 'Last 24 hours', kind: 'days', amount: 1 },
  '7': { key: '7', label: 'Last 7 days', kind: 'days', amount: 7 },
  '30': { key: '30', label: 'Last 30 days', kind: 'days', amount: 30 },
  '60': { key: '60', label: 'Last 60 days', kind: 'days', amount: 60 },
  '3m': { key: '3m', label: 'Last 3 months', kind: 'months', amount: 3 },
  '6m': { key: '6m', label: 'Last 6 months', kind: 'months', amount: 6 },
});

export const periodOptions = Object.freeze(Object.values(PERIODS).map(({ key, label }) => ({ key, label })));

function subtractUtcMonths(date, months) {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

export function resolvePeriod(key, now = new Date()) {
  const definition = PERIODS[key];
  if (!definition) throw new RangeError(`Unsupported period: ${key}`);

  const to = new Date(now);
  if (Number.isNaN(to.getTime())) throw new TypeError('now must be a valid date.');
  const from = definition.kind === 'days'
    ? new Date(to.getTime() - definition.amount * 24 * 60 * 60 * 1_000)
    : subtractUtcMonths(to, definition.amount);

  return Object.freeze({
    key: definition.key,
    label: definition.label,
    from: from.toISOString(),
    to: to.toISOString(),
  });
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function completionInPeriod(ticket, fromMs, toMs) {
  const stats = ticket.stats || {};
  return [stats.resolved_at, stats.closed_at]
    .map(validDate)
    .some((date) => date && date.getTime() >= fromMs && date.getTime() <= toMs);
}

function durationSeconds(ticket, directField, endField) {
  const stats = ticket.stats || {};
  const rawDirect = stats[directField];
  if (rawDirect !== null && rawDirect !== undefined && rawDirect !== '') {
    const direct = Number(rawDirect);
    if (Number.isFinite(direct) && direct >= 0) return direct;
  }

  const start = validDate(ticket.created_at || stats.created_at);
  const end = validDate(stats[endField]);
  if (!start || !end) return null;
  const seconds = (end.getTime() - start.getTime()) / 1_000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function createAccumulator(id, name) {
  return {
    id,
    name,
    ticketCount: 0,
    firstResponseSeconds: 0,
    firstResponseSamples: 0,
    resolutionSeconds: 0,
    resolutionSamples: 0,
    firstResponseMet: 0,
    firstResponseEligible: 0,
    resolutionMet: 0,
    resolutionEligible: 0,
    overallMet: 0,
    overallEligible: 0,
  };
}

function addTicket(accumulator, ticket) {
  accumulator.ticketCount += 1;

  const firstResponse = durationSeconds(ticket, 'first_resp_time_in_secs', 'first_responded_at');
  if (firstResponse !== null) {
    accumulator.firstResponseSeconds += firstResponse;
    accumulator.firstResponseSamples += 1;
  }

  const resolution = durationSeconds(ticket, 'resolution_time_in_secs', 'resolved_at')
    ?? durationSeconds(ticket, 'resolution_time_in_secs', 'closed_at');
  if (resolution !== null) {
    accumulator.resolutionSeconds += resolution;
    accumulator.resolutionSamples += 1;
  }

  const firstResponseEligible = typeof ticket.fr_escalated === 'boolean';
  const resolutionEligible = typeof ticket.is_escalated === 'boolean';

  if (firstResponseEligible) {
    accumulator.firstResponseEligible += 1;
    if (!ticket.fr_escalated) accumulator.firstResponseMet += 1;
  }
  if (resolutionEligible) {
    accumulator.resolutionEligible += 1;
    if (!ticket.is_escalated) accumulator.resolutionMet += 1;
  }
  if (firstResponseEligible && resolutionEligible) {
    accumulator.overallEligible += 1;
    if (!ticket.fr_escalated && !ticket.is_escalated) accumulator.overallMet += 1;
  }
}

function compliance(met, eligible) {
  return {
    met,
    eligible,
    percent: eligible ? Math.round((met / eligible) * 1_000) / 10 : null,
  };
}

function finish(accumulator) {
  return {
    id: accumulator.id,
    name: accumulator.name,
    ticketCount: accumulator.ticketCount,
    overall: compliance(accumulator.overallMet, accumulator.overallEligible),
    firstResponse: compliance(accumulator.firstResponseMet, accumulator.firstResponseEligible),
    resolution: compliance(accumulator.resolutionMet, accumulator.resolutionEligible),
    averageFirstResponseSeconds: accumulator.firstResponseSamples
      ? Math.round(accumulator.firstResponseSeconds / accumulator.firstResponseSamples)
      : null,
    firstResponseSamples: accumulator.firstResponseSamples,
    averageResolutionSeconds: accumulator.resolutionSamples
      ? Math.round(accumulator.resolutionSeconds / accumulator.resolutionSamples)
      : null,
    resolutionSamples: accumulator.resolutionSamples,
  };
}

export function buildSlaReport({ groups, agents = new Map(), tickets, period }) {
  const fromMs = new Date(period.from).getTime();
  const toMs = new Date(period.to).getTime();
  const teamAccumulators = new Map();
  const overallAccumulator = createAccumulator('all', 'All teams');

  function createTeamAccumulator(id, name) {
    const accumulator = createAccumulator(id, name);
    accumulator.technicians = new Map();
    return accumulator;
  }

  for (const group of groups) {
    teamAccumulators.set(
      String(group.id),
      createTeamAccumulator(String(group.id), group.name || `Group ${group.id}`),
    );
  }

  const seenTicketIds = new Set();
  for (const ticket of tickets) {
    const ticketKey = String(ticket.id);
    if (seenTicketIds.has(ticketKey) || !completionInPeriod(ticket, fromMs, toMs)) continue;
    seenTicketIds.add(ticketKey);

    const groupKey = ticket.group_id == null ? 'unassigned' : String(ticket.group_id);
    if (!teamAccumulators.has(groupKey)) {
      const name = ticket.group_id == null ? 'No group' : `Group ${ticket.group_id}`;
      teamAccumulators.set(groupKey, createTeamAccumulator(groupKey, name));
    }

    const team = teamAccumulators.get(groupKey);
    const responderKey = ticket.responder_id == null ? 'unassigned' : String(ticket.responder_id);
    if (!team.technicians.has(responderKey)) {
      const technicianName = responderKey === 'unassigned'
        ? 'Unassigned'
        : agents.get(responderKey) || `Agent ${ticket.responder_id}`;
      team.technicians.set(responderKey, createAccumulator(responderKey, technicianName));
    }

    addTicket(team, ticket);
    addTicket(team.technicians.get(responderKey), ticket);
    addTicket(overallAccumulator, ticket);
  }

  const teams = [...teamAccumulators.values()]
    .map((team) => ({
      ...finish(team),
      technicians: [...team.technicians.values()]
        .map(finish)
        .sort((a, b) => b.ticketCount - a.ticketCount || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.ticketCount - a.ticketCount || a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    period,
    overall: finish(overallAccumulator),
    teams,
  };
}
