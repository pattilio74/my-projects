const elements = {
  period: document.querySelector('#period'),
  refresh: document.querySelector('#refresh'),
  exportCsv: document.querySelector('#export'),
  loading: document.querySelector('#loading'),
  error: document.querySelector('#error'),
  summary: document.querySelector('#summary'),
  teamSection: document.querySelector('#team-section'),
  summaryTitle: document.querySelector('#summary-title'),
  dateRange: document.querySelector('#date-range'),
  updated: document.querySelector('#updated'),
  overallSla: document.querySelector('#overall-sla'),
  overallDetail: document.querySelector('#overall-detail'),
  responseSla: document.querySelector('#response-sla'),
  responseDetail: document.querySelector('#response-detail'),
  resolutionSla: document.querySelector('#resolution-sla'),
  resolutionDetail: document.querySelector('#resolution-detail'),
  mttr: document.querySelector('#mttr'),
  mttrDetail: document.querySelector('#mttr-detail'),
  ticketCount: document.querySelector('#ticket-count'),
  search: document.querySelector('#team-search'),
  rows: document.querySelector('#team-rows'),
  empty: document.querySelector('#empty'),
};

let currentReport = null;
let currentTeams = [];
let requestSequence = 0;

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatPercent(metric) {
  return metric.percent === null ? 'N/A' : `${metric.percent.toFixed(1)}%`;
}

function metricDetail(metric) {
  return metric.eligible ? `${metric.met.toLocaleString()} of ${metric.eligible.toLocaleString()} eligible tickets met` : 'No eligible tickets';
}

function formatDuration(totalSeconds) {
  if (totalSeconds === null) return 'N/A';
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}

function slaClass(metric) {
  if (metric.percent === null) return 'na';
  if (metric.percent >= 95) return 'good';
  if (metric.percent >= 85) return 'warn';
  return 'bad';
}

function slaCell(metric) {
  const cell = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `sla ${slaClass(metric)}`;
  badge.textContent = formatPercent(metric);
  const detail = document.createElement('span');
  detail.className = 'subvalue';
  detail.textContent = metric.eligible ? `${metric.met}/${metric.eligible} met` : 'No eligible tickets';
  cell.append(badge, detail);
  return cell;
}

function textCell(value, className) {
  const cell = document.createElement('td');
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function durationCell(value, samples) {
  const cell = document.createElement('td');
  cell.textContent = formatDuration(value);
  const detail = document.createElement('span');
  detail.className = 'subvalue';
  detail.textContent = samples ? `${samples.toLocaleString()} measured` : 'No timing data';
  cell.append(detail);
  return cell;
}

function resultRow(result, rowClass, nameClass) {
  const row = document.createElement('tr');
  row.className = rowClass;
  row.append(
    textCell(result.name, nameClass),
    textCell(result.ticketCount.toLocaleString()),
    slaCell(result.overall),
    slaCell(result.firstResponse),
    slaCell(result.resolution),
    textCell(formatDuration(result.averageFirstResponseSeconds)),
    durationCell(result.averageResolutionSeconds, result.resolutionSamples),
  );
  return row;
}

function renderTeams() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const fragment = document.createDocumentFragment();
  let visibleTeamCount = 0;

  for (const team of currentTeams) {
    const technicians = Array.isArray(team.technicians) ? team.technicians : [];
    const teamMatches = team.name.toLocaleLowerCase().includes(query);
    const visibleTechnicians = !query || teamMatches
      ? technicians
      : technicians.filter((technician) => technician.name.toLocaleLowerCase().includes(query));

    if (query && !teamMatches && visibleTechnicians.length === 0) continue;
    visibleTeamCount += 1;
    fragment.append(resultRow(team, 'team-row', 'team-name'));
    for (const technician of visibleTechnicians) {
      fragment.append(resultRow(technician, 'technician-row', 'technician-name'));
    }
  }

  elements.rows.replaceChildren(fragment);
  elements.empty.hidden = visibleTeamCount > 0;
}

function render(report) {
  const { overall, period } = report;
  elements.summaryTitle.textContent = period.label;
  elements.dateRange.textContent = `${formatDate(period.from)} through ${formatDate(period.to)}`;
  elements.updated.textContent = `Updated ${formatDate(report.generatedAt)}`;

  elements.overallSla.textContent = formatPercent(overall.overall);
  elements.overallDetail.textContent = metricDetail(overall.overall);
  elements.responseSla.textContent = formatPercent(overall.firstResponse);
  elements.responseDetail.textContent = metricDetail(overall.firstResponse);
  elements.resolutionSla.textContent = formatPercent(overall.resolution);
  elements.resolutionDetail.textContent = metricDetail(overall.resolution);
  elements.mttr.textContent = formatDuration(overall.averageResolutionSeconds);
  elements.mttrDetail.textContent = overall.resolutionSamples
    ? `${overall.resolutionSamples.toLocaleString()} completed tickets measured`
    : 'No resolution timing data';
  elements.ticketCount.textContent = overall.ticketCount.toLocaleString();

  currentReport = report;
  currentTeams = report.teams;
  elements.exportCsv.disabled = false;
  renderTeams();
  elements.summary.hidden = false;
  elements.teamSection.hidden = false;
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function exportRow(rowType, teamName, technicianName, result, report) {
  return [
    rowType,
    teamName,
    technicianName,
    report.period.label,
    report.period.from,
    report.period.to,
    report.generatedAt,
    result.ticketCount,
    result.overall.percent,
    result.overall.met,
    result.overall.eligible,
    result.firstResponse.percent,
    result.firstResponse.met,
    result.firstResponse.eligible,
    result.resolution.percent,
    result.resolution.met,
    result.resolution.eligible,
    result.averageFirstResponseSeconds,
    result.firstResponseSamples,
    result.averageResolutionSeconds,
    result.resolutionSamples,
  ];
}

function exportCurrentReport() {
  if (!currentReport) return;

  const headers = [
    'Row Type',
    'Team',
    'Technician',
    'Period',
    'Period Start',
    'Period End',
    'Generated At',
    'Completed Tickets',
    'Overall SLA Percent',
    'Overall SLA Met',
    'Overall SLA Eligible',
    'First Response SLA Percent',
    'First Response SLA Met',
    'First Response SLA Eligible',
    'Resolution SLA Percent',
    'Resolution SLA Met',
    'Resolution SLA Eligible',
    'Average First Response Seconds',
    'First Response Samples',
    'MTTR Seconds',
    'MTTR Samples',
  ];
  const teamRows = currentReport.teams.flatMap((team) => [
    exportRow('Team', team.name, '', team, currentReport),
    ...(team.technicians || []).map((technician) => (
      exportRow('Technician', team.name, technician.name, technician, currentReport)
    )),
  ]);
  const rows = [
    headers,
    exportRow('Overall', 'All teams', '', currentReport.overall, currentReport),
    ...teamRows,
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  const date = new Date(currentReport.generatedAt).toISOString().slice(0, 10);
  link.href = url;
  link.download = `team-sla-${currentReport.period.key}-${date}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadReport(forceRefresh = false) {
  const sequence = ++requestSequence;
  currentReport = null;
  elements.loading.hidden = false;
  elements.error.hidden = true;
  elements.refresh.disabled = true;
  elements.exportCsv.disabled = true;

  try {
    const params = new URLSearchParams({ period: elements.period.value });
    if (forceRefresh) params.set('refresh', '1');
    const response = await fetch(`/api/sla?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with status ${response.status}.`);
    if (sequence === requestSequence) render(payload);
  } catch (error) {
    if (sequence === requestSequence) {
      elements.error.textContent = error.message;
      elements.error.hidden = false;
    }
  } finally {
    if (sequence === requestSequence) {
      elements.loading.hidden = true;
      elements.refresh.disabled = false;
    }
  }
}

elements.period.addEventListener('change', () => loadReport(false));
elements.refresh.addEventListener('click', () => loadReport(true));
elements.exportCsv.addEventListener('click', exportCurrentReport);
elements.search.addEventListener('input', renderTeams);
loadReport(false);
