import { FreshserviceClient, STATUS } from "./freshservice.mjs";

// Freshservice priority codes.
export const PRIORITY = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };
export const STATUS_NAME = {
  [STATUS.OPEN]: "Open",
  [STATUS.PENDING]: "Pending",
  [STATUS.ASSIGNED]: "Assigned",
  [STATUS.WORK_IN_PROGRESS]: "Work in Progress",
  [STATUS.SCHEDULED]: "Scheduled",
};

/** Whole days elapsed since an ISO timestamp (never negative). */
export function ageInDays(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * Fetch everything from Freshservice and return the aggregated report plus totals.
 * Reusable by both the CLI and the web server.
 * @param {object} opts
 * @param {string} opts.domain
 * @param {string} opts.apiKey
 */
export async function getReport({ domain, apiKey }) {
  const client = new FreshserviceClient({ domain, apiKey });
  const activeStatusQuery = [
    STATUS.OPEN,
    STATUS.PENDING,
    STATUS.ASSIGNED,
    STATUS.WORK_IN_PROGRESS,
    STATUS.SCHEDULED,
  ].map((status) => `status:${status}`).join(" OR ");
  const [departments, agents, groups, activeTickets] = await Promise.all([
    client.getDepartments(),
    client.getAgents(),
    client.getGroups(),
    client.getTicketsByFilter(activeStatusQuery),
  ]);

  const ticketsForStatus = (status) => activeTickets.filter((ticket) => ticket.status === status);
  const openTickets = ticketsForStatus(STATUS.OPEN);
  const pendingTickets = ticketsForStatus(STATUS.PENDING);
  const assignedTickets = ticketsForStatus(STATUS.ASSIGNED);
  const workInProgressTickets = ticketsForStatus(STATUS.WORK_IN_PROGRESS);
  const scheduledTickets = ticketsForStatus(STATUS.SCHEDULED);

  const rows = buildReport({
    openTickets,
    pendingTickets,
    assignedTickets,
    workInProgressTickets,
    scheduledTickets,
    departments,
    agents,
    groups,
  });
  const totals = {
    open: rows.reduce((s, r) => s + r.open, 0),
    pending: rows.reduce((s, r) => s + r.pending, 0),
    assigned: rows.reduce((s, r) => s + r.assigned, 0),
    workInProgress: rows.reduce((s, r) => s + r.workInProgress, 0),
    scheduled: rows.reduce((s, r) => s + r.scheduled, 0),
    total: rows.reduce((s, r) => s + r.total, 0),
    priority: rows.reduce(
      (acc, r) => {
        acc.Low += r.priority.Low;
        acc.Medium += r.priority.Medium;
        acc.High += r.priority.High;
        acc.Urgent += r.priority.Urgent;
        return acc;
      },
      { Low: 0, Medium: 0, High: 0, Urgent: 0 }
    ),
  };

  // Pending tickets grouped by the tenant's Pending custom field. Keep an
  // explicit fallback bucket so the breakdown reconciles to totals.pending.
  const pendingReasonCounts = new Map();
  for (const ticket of pendingTickets) {
    const rawReason = ticket.custom_fields?.pending;
    const reason = String(rawReason ?? "").trim() || "No pending reason";
    pendingReasonCounts.set(reason, (pendingReasonCounts.get(reason) || 0) + 1);
  }
  const pendingReasonSummary = [...pendingReasonCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Tickets grouped by their assigned group, sorted by count descending.
  const groupCounts = new Map();
  for (const r of rows) {
    for (const t of r.tickets) {
      groupCounts.set(t.group, (groupCounts.get(t.group) || 0) + 1);
    }
  }
  const groupSummary = [...groupCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    rows,
    totals,
    pendingReasonSummary,
    groupSummary,
    customerCount: departments.size,
    agentCount: agents.size,
    groupCount: groups.size,
    generatedAt: new Date().toISOString(),
  };
}

export function resolveTeamSlaPeriod(period = "7", now = new Date()) {
  const key = String(period).toLowerCase();
  const labels = {
    "7": "Last week (7 days)",
    "30": "Last 30 days",
    "60": "Last 60 days",
    "3m": "Last 3 months",
    "6m": "Last 6 months",
  };
  if (!labels[key]) {
    throw new Error("SLA period must be one of: 7, 30, 60, 3m, 6m");
  }

  const to = new Date(now);
  if (Number.isNaN(to.getTime())) throw new Error("A valid SLA period end date is required");

  let from;
  const calendarMonths = { "3m": 3, "6m": 6 }[key];
  if (calendarMonths) {
    from = new Date(to);
    const originalDay = from.getUTCDate();
    from.setUTCDate(1);
    from.setUTCMonth(from.getUTCMonth() - calendarMonths);
    const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
    from.setUTCDate(Math.min(originalDay, lastDay));
  } else {
    from = new Date(to.getTime() - Number(key) * 86_400_000);
  }

  return { key, label: labels[key], from, to };
}

export async function getTeamSlaReport({ domain, apiKey, period = "7" }) {
  const range = resolveTeamSlaPeriod(period);
  const client = new FreshserviceClient({ domain, apiKey });
  const [groups, tickets] = await Promise.all([
    client.getGroups(),
    client.getTicketsUpdatedSince(range.from, { includeStats: true }),
  ]);
  const report = buildTeamSlaReport({ tickets, groups, from: range.from, to: range.to });
  report.period.key = range.key;
  report.period.label = range.label;
  return report;
}

/**
 * Aggregate active ticket counts per customer (department), including
 * status and priority breakdowns plus ticket details.
 * @param {Map<number,string>} [args.agents]  id -> agent full name
 * @param {Map<number,string>} [args.groups]  id -> group name
 * @returns {Array<{
 *   customerId:(number|string|null), customer:string,
 *   open:number, pending:number, assigned:number, workInProgress:number,
 *   scheduled:number, total:number,
 *   priority:{Low:number,Medium:number,High:number,Urgent:number},
 *   agents:string[], groups:string[],
 *   oldestAgeDays:(number|null),
 *   tickets:Array<{id:number, subject:string, status:string, pendingReason:string, priority:string, priorityCode:number, agent:string, group:string, createdAt:(string|null), ageDays:(number|null)}>
 * }>}
 */
export function buildReport({
  openTickets = [],
  pendingTickets = [],
  assignedTickets = [],
  workInProgressTickets = [],
  scheduledTickets = [],
  departments,
  agents = new Map(),
  groups = new Map(),
}) {
  const rows = new Map();
  const UNASSIGNED = "Unassigned";
  const NO_GROUP = "No group";

  const rowFor = (deptId) => {
    const key = deptId ?? "unassigned";
    if (!rows.has(key)) {
      rows.set(key, {
        customerId: deptId ?? null,
        customer: deptId
          ? departments.get(deptId) || `Unknown department (${deptId})`
          : "(No customer assigned)",
        open: 0,
        pending: 0,
        assigned: 0,
        workInProgress: 0,
        scheduled: 0,
        total: 0,
        priority: { Low: 0, Medium: 0, High: 0, Urgent: 0 },
        agents: new Set(),
        groups: new Set(),
        tickets: [],
      });
    }
    return rows.get(key);
  };

  const add = (ticket, statusName, statusKey) => {
    const r = rowFor(ticket.department_id);
    r[statusKey]++;
    r.total++;
    const pName = PRIORITY[ticket.priority] || "Low";
    r.priority[pName]++;
    const agentName = ticket.responder_id ? agents.get(ticket.responder_id) || `Agent ${ticket.responder_id}` : UNASSIGNED;
    r.agents.add(agentName);
    const groupName = ticket.group_id ? groups.get(ticket.group_id) || `Group ${ticket.group_id}` : NO_GROUP;
    r.groups.add(groupName);
    const createdAt = ticket.created_at || null;
    const pendingReason = statusKey === "pending"
      ? String(ticket.custom_fields?.pending ?? "").trim() || "No pending reason"
      : "–";
    r.tickets.push({
      id: ticket.id,
      subject: ticket.subject || "(no subject)",
      status: statusName,
      pendingReason,
      priority: pName,
      priorityCode: ticket.priority ?? 1,
      agent: agentName,
      group: groupName,
      createdAt,
      ageDays: createdAt ? ageInDays(createdAt) : null,
    });
  };

  for (const t of openTickets) add(t, STATUS_NAME[STATUS.OPEN], "open");
  for (const t of pendingTickets) add(t, STATUS_NAME[STATUS.PENDING], "pending");
  for (const t of assignedTickets) add(t, STATUS_NAME[STATUS.ASSIGNED], "assigned");
  for (const t of workInProgressTickets) add(t, STATUS_NAME[STATUS.WORK_IN_PROGRESS], "workInProgress");
  for (const t of scheduledTickets) add(t, STATUS_NAME[STATUS.SCHEDULED], "scheduled");

  // Sort each customer's tickets by priority (Urgent first), then ticket id;
  // convert the agents Set to a sorted array (Unassigned last);
  // record the oldest ticket age for the customer.
  for (const r of rows.values()) {
    r.tickets.sort((a, b) => b.priorityCode - a.priorityCode || a.id - b.id);
    r.agents = [...r.agents].sort((a, b) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return a.localeCompare(b);
    });
    r.groups = [...r.groups].sort((a, b) => {
      if (a === NO_GROUP) return 1;
      if (b === NO_GROUP) return -1;
      return a.localeCompare(b);
    });
    const ages = r.tickets.map((t) => t.ageDays).filter((d) => d != null);
    r.oldestAgeDays = ages.length ? Math.max(...ages) : null;
  }

  return [...rows.values()].sort(
    (a, b) => b.total - a.total || a.customer.localeCompare(b.customer)
  );
}

/**
 * Build SLA metrics by the ticket's assigned Freshservice group.
 * Only tickets resolved or closed within the requested period are included.
 */
export function buildTeamSlaReport({ tickets, groups = new Map(), from, to }) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new Error("A valid SLA reporting period is required");
  }

  const createAccumulator = (groupId = null, name = "All teams") => ({
    groupId,
    name,
    ticketCount: 0,
    firstResponseSecondsTotal: 0,
    firstResponseSampleCount: 0,
    resolutionSecondsTotal: 0,
    resolutionSampleCount: 0,
    firstResponseMet: 0,
    firstResponseEligible: 0,
    resolutionMet: 0,
    resolutionEligible: 0,
    overallMet: 0,
    overallEligible: 0,
  });

  const teamAccumulators = new Map(
    [...groups.entries()].map(([groupId, name]) => [String(groupId), createAccumulator(groupId, name)])
  );
  const overall = createAccumulator();
  const seenTicketIds = new Set();

  const validTimestamp = (value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  };

  const durationSeconds = (nativeValue, startValue, endValue) => {
    if (nativeValue !== null && nativeValue !== undefined && nativeValue !== "") {
      const seconds = Number(nativeValue);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    }
    const start = validTimestamp(startValue);
    const end = validTimestamp(endValue);
    return start !== null && end !== null && end >= start ? (end - start) / 1000 : null;
  };

  const record = (accumulator, ticket, completedAt) => {
    const stats = ticket.stats || {};
    accumulator.ticketCount++;

    const firstResponseSeconds = durationSeconds(
      stats.first_resp_time_in_secs,
      ticket.created_at || stats.created_at,
      stats.first_responded_at
    );
    if (firstResponseSeconds !== null) {
      accumulator.firstResponseSecondsTotal += firstResponseSeconds;
      accumulator.firstResponseSampleCount++;
    }

    const resolutionSeconds = durationSeconds(
      stats.resolution_time_in_secs,
      ticket.created_at || stats.created_at,
      stats.resolved_at || completedAt
    );
    if (resolutionSeconds !== null) {
      accumulator.resolutionSecondsTotal += resolutionSeconds;
      accumulator.resolutionSampleCount++;
    }

    if (typeof ticket.fr_escalated === "boolean") {
      accumulator.firstResponseEligible++;
      if (!ticket.fr_escalated) accumulator.firstResponseMet++;
    }
    if (typeof ticket.is_escalated === "boolean") {
      accumulator.resolutionEligible++;
      if (!ticket.is_escalated) accumulator.resolutionMet++;
    }
    if (typeof ticket.fr_escalated === "boolean" && typeof ticket.is_escalated === "boolean") {
      accumulator.overallEligible++;
      if (!ticket.fr_escalated && !ticket.is_escalated) accumulator.overallMet++;
    }
  };

  for (const ticket of tickets) {
    if (ticket.id != null && seenTicketIds.has(ticket.id)) continue;
    if (ticket.id != null) seenTicketIds.add(ticket.id);

    const resolvedAt = validTimestamp(ticket.stats?.resolved_at);
    const closedAt = validTimestamp(ticket.stats?.closed_at);
    const resolvedInPeriod = resolvedAt !== null && resolvedAt >= fromMs && resolvedAt <= toMs;
    const closedInPeriod = closedAt !== null && closedAt >= fromMs && closedAt <= toMs;
    if (!resolvedInPeriod && !closedInPeriod) continue;

    const key = ticket.group_id == null ? "unassigned" : String(ticket.group_id);
    if (!teamAccumulators.has(key)) {
      teamAccumulators.set(
        key,
        createAccumulator(
          ticket.group_id ?? null,
          ticket.group_id == null ? "No group" : `Group ${ticket.group_id}`
        )
      );
    }
    const completedAt = ticket.stats?.resolved_at || ticket.stats?.closed_at;
    record(teamAccumulators.get(key), ticket, completedAt);
    record(overall, ticket, completedAt);
  }

  const finalize = (accumulator) => {
    const percentage = (met, eligible) =>
      eligible ? Number(((met / eligible) * 100).toFixed(1)) : null;
    return {
      groupId: accumulator.groupId,
      name: accumulator.name,
      ticketCount: accumulator.ticketCount,
      avgFirstResponseSeconds: accumulator.firstResponseSampleCount
        ? Math.round(accumulator.firstResponseSecondsTotal / accumulator.firstResponseSampleCount)
        : null,
      firstResponseSampleCount: accumulator.firstResponseSampleCount,
      avgResolutionSeconds: accumulator.resolutionSampleCount
        ? Math.round(accumulator.resolutionSecondsTotal / accumulator.resolutionSampleCount)
        : null,
      resolutionSampleCount: accumulator.resolutionSampleCount,
      firstResponseMet: accumulator.firstResponseMet,
      firstResponseEligible: accumulator.firstResponseEligible,
      firstResponseSlaPct: percentage(accumulator.firstResponseMet, accumulator.firstResponseEligible),
      resolutionMet: accumulator.resolutionMet,
      resolutionEligible: accumulator.resolutionEligible,
      resolutionSlaPct: percentage(accumulator.resolutionMet, accumulator.resolutionEligible),
      overallMet: accumulator.overallMet,
      overallEligible: accumulator.overallEligible,
      overallSlaPct: percentage(accumulator.overallMet, accumulator.overallEligible),
    };
  };

  const teams = [...teamAccumulators.values()]
    .map(finalize)
    .sort((a, b) => b.ticketCount - a.ticketCount || a.name.localeCompare(b.name));

  return {
    period: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      days: Math.round((toMs - fromMs) / 86_400_000),
      basis: "Tickets resolved or closed during the period, attributed to their assigned group",
    },
    overall: finalize(overall),
    teams,
  };
}

/** Render an aligned text table for the CLI. */
export function renderTable(rows) {
  if (rows.length === 0) return "No active tickets found.";

  const headers = [
    "Customer",
    "Open",
    "Pending",
    "Assigned",
    "WIP",
    "Scheduled",
    "Low",
    "Med",
    "High",
    "Urgent",
    "Total",
    "Oldest(d)",
  ];
  const data = rows.map((r) => [
    r.customer,
    String(r.open),
    String(r.pending),
    String(r.assigned),
    String(r.workInProgress),
    String(r.scheduled),
    String(r.priority.Low),
    String(r.priority.Medium),
    String(r.priority.High),
    String(r.priority.Urgent),
    String(r.total),
    r.oldestAgeDays == null ? "-" : String(r.oldestAgeDays),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length))
  );

  const line = (cells) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");

  const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0);

  const out = [];
  out.push(line(headers));
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) out.push(line(row));
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  out.push(
    line([
      "TOTAL",
      String(sum((r) => r.open)),
      String(sum((r) => r.pending)),
      String(sum((r) => r.assigned)),
      String(sum((r) => r.workInProgress)),
      String(sum((r) => r.scheduled)),
      String(sum((r) => r.priority.Low)),
      String(sum((r) => r.priority.Medium)),
      String(sum((r) => r.priority.High)),
      String(sum((r) => r.priority.Urgent)),
      String(sum((r) => r.total)),
      "",
    ])
  );

  // Ticket numbers + assigned agents per customer.
  out.push("");
  out.push("Tickets per customer (agents in brackets):");
  for (const r of rows) {
    out.push(`  ${r.customer}  [agents: ${r.agents.join(", ")}]`);
    for (const t of r.tickets) {
      const age = t.ageDays == null ? "?" : `${t.ageDays}d`;
      out.push(`    #${t.id} ${t.subject} (${t.priority}/${t.status}, ${t.agent}, ${age} old)`);
    }
  }
  return out.join("\n");
}

/** Render CSV: one row per ticket so ticket numbers and priorities are captured. */
export function renderCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["customer_id,customer,ticket_id,subject,status,pending_reason,priority,agent,group,age_days,created_at"];
  for (const r of rows) {
    if (r.tickets.length === 0) continue;
    for (const t of r.tickets) {
      lines.push(
        [r.customerId ?? "", r.customer, t.id, t.subject, t.status, t.pendingReason, t.priority, t.agent, t.group, t.ageDays ?? "", t.createdAt ?? ""]
          .map(esc)
          .join(",")
      );
    }
  }
  return lines.join("\n");
}

/** Render a compact per-customer summary CSV (counts only). */
export function renderSummaryCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["customer_id,customer,open,pending,assigned,work_in_progress,scheduled,low,medium,high,urgent,total,oldest_age_days,groups,agents,ticket_numbers"];
  for (const r of rows) {
    lines.push(
      [
        r.customerId ?? "",
        r.customer,
        r.open,
        r.pending,
        r.assigned,
        r.workInProgress,
        r.scheduled,
        r.priority.Low,
        r.priority.Medium,
        r.priority.High,
        r.priority.Urgent,
        r.total,
        r.oldestAgeDays ?? "",
        r.groups.join("; "),
        r.agents.join("; "),
        r.tickets.map((t) => `#${t.id}`).join(" "),
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n");
}

export { STATUS };
