const PERIODS = Object.freeze({
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

export const BASIS_OPTIONS = Object.freeze([
  { key: 'resolution', label: 'Resolution date' },
  { key: 'creation', label: 'Creation date' },
]);

export function resolveBasis(value) {
  const basis = BASIS_OPTIONS.find((option) => option.key === value);
  return (basis || BASIS_OPTIONS[0]).key;
}

function inRange(date, fromMs, toMs) {
  return Boolean(date) && date.getTime() >= fromMs && date.getTime() <= toMs;
}

function ticketInPeriod(ticket, fromMs, toMs, basis) {
  const stats = ticket.stats || {};
  if (basis === 'creation') {
    const created = validDate(ticket.created_at || stats.created_at);
    return inRange(created, fromMs, toMs);
  }
  return [stats.resolved_at, stats.closed_at]
    .map(validDate)
    .some((date) => inRange(date, fromMs, toMs));
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

export function buildSlaReport({ departments, tickets, period, basis = 'resolution' }) {
  const activeBasis = resolveBasis(basis);
  const fromMs = new Date(period.from).getTime();
  const toMs = new Date(period.to).getTime();
  const customerAccumulators = new Map();
  const overallAccumulator = createAccumulator('all', 'All customers');

  for (const department of departments) {
    customerAccumulators.set(
      String(department.id),
      createAccumulator(String(department.id), department.name || `Department ${department.id}`),
    );
  }

  const seenTicketIds = new Set();
  for (const ticket of tickets) {
    const ticketKey = String(ticket.id);
    if (seenTicketIds.has(ticketKey) || !ticketInPeriod(ticket, fromMs, toMs, activeBasis)) continue;
    seenTicketIds.add(ticketKey);

    const customerKey = ticket.department_id == null ? 'unassigned' : String(ticket.department_id);
    if (!customerAccumulators.has(customerKey)) {
      const name = ticket.department_id == null ? 'No customer' : `Department ${ticket.department_id}`;
      customerAccumulators.set(customerKey, createAccumulator(customerKey, name));
    }

    addTicket(customerAccumulators.get(customerKey), ticket);
    addTicket(overallAccumulator, ticket);
  }

  const customers = [...customerAccumulators.values()]
    .map(finish)
    .sort((a, b) => b.ticketCount - a.ticketCount || a.name.localeCompare(b.name));

  const basisOption = BASIS_OPTIONS.find((option) => option.key === activeBasis);

  return {
    generatedAt: new Date().toISOString(),
    period,
    basis: { key: activeBasis, label: basisOption.label },
    overall: finish(overallAccumulator),
    customers,
  };
}
