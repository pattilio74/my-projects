const elements = {
  period: document.querySelector('#period'),
  basis: document.querySelector('#basis'),
  refresh: document.querySelector('#refresh'),
  exportCsv: document.querySelector('#export'),
  loading: document.querySelector('#loading'),
  error: document.querySelector('#error'),
  summary: document.querySelector('#summary'),
  customerSection: document.querySelector('#customer-section'),
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
  ticketCountLabel: document.querySelector('#ticket-count-label'),
  ticketCountDetail: document.querySelector('#ticket-count-detail'),
  completedHeader: document.querySelector('#completed-header'),
  search: document.querySelector('#customer-search'),
  rows: document.querySelector('#customer-rows'),
  empty: document.querySelector('#empty'),
};

let currentReport = null;
let currentCustomers = [];
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

function hasSlaData(customer) {
  return customer.overall.percent !== null
    || customer.firstResponse.percent !== null
    || customer.resolution.percent !== null;
}

function renderCustomers() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const customers = currentCustomers
    .filter(hasSlaData)
    .filter((customer) => customer.name.toLocaleLowerCase().includes(query));
  const fragment = document.createDocumentFragment();

  for (const customer of customers) {
    const row = document.createElement('tr');
    row.append(
      textCell(customer.name, 'customer-name'),
      textCell(customer.ticketCount.toLocaleString()),
      slaCell(customer.overall),
      slaCell(customer.firstResponse),
      slaCell(customer.resolution),
      textCell(formatDuration(customer.averageFirstResponseSeconds)),
      durationCell(customer.averageResolutionSeconds, customer.resolutionSamples),
    );
    fragment.append(row);
  }

  elements.rows.replaceChildren(fragment);
  elements.empty.hidden = customers.length > 0;
}

function applyBasisLabels(basis) {
  const byCreation = basis && basis.key === 'creation';
  const countLabel = byCreation ? 'Tickets created' : 'Completed tickets';
  const countDetail = byCreation ? 'Created in period' : 'Resolved or closed in period';
  const columnLabel = byCreation ? 'Created' : 'Completed';

  if (elements.ticketCountLabel) elements.ticketCountLabel.textContent = countLabel;
  if (elements.ticketCountDetail) elements.ticketCountDetail.textContent = countDetail;
  if (elements.completedHeader) elements.completedHeader.textContent = columnLabel;
}

function render(report) {
  const { overall, period } = report;
  applyBasisLabels(report.basis);
  const basisSuffix = report.basis ? ` · ${report.basis.label}` : '';
  elements.summaryTitle.textContent = `${period.label}${basisSuffix}`;
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
  currentCustomers = report.customers;
  elements.exportCsv.disabled = false;
  renderCustomers();
  elements.summary.hidden = false;
  elements.customerSection.hidden = false;
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function exportRow(rowType, result, report) {
  return [
    rowType,
    result.name,
    report.period.label,
    report.basis ? report.basis.label : 'Resolution date',
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
    'Customer',
    'Period',
    'Measured By',
    'Period Start',
    'Period End',
    'Generated At',
    'Ticket Count',
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
  const rows = [
    headers,
    exportRow('Overall', currentReport.overall, currentReport),
    ...currentReport.customers.map((customer) => exportRow('Customer', customer, currentReport)),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  const date = new Date(currentReport.generatedAt).toISOString().slice(0, 10);
  link.href = url;
  const basisKey = currentReport.basis ? currentReport.basis.key : 'resolution';
  link.download = `customer-sla-${currentReport.period.key}-${basisKey}-${date}.csv`;
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
    const params = new URLSearchParams({ period: elements.period.value, basis: elements.basis.value });
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

function restoreSelection(select, storageKey) {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && [...select.options].some((option) => option.value === saved)) {
      select.value = saved;
    }
  } catch {
    // Ignore storage access errors (e.g. privacy mode).
  }
}

function persistSelection(select, storageKey) {
  try {
    localStorage.setItem(storageKey, select.value);
  } catch {
    // Ignore storage access errors.
  }
}

restoreSelection(elements.period, 'customer-sla.period');
restoreSelection(elements.basis, 'customer-sla.basis');

elements.period.addEventListener('change', () => {
  persistSelection(elements.period, 'customer-sla.period');
  loadReport(false);
});
elements.basis.addEventListener('change', () => {
  persistSelection(elements.basis, 'customer-sla.basis');
  loadReport(false);
});
elements.refresh.addEventListener('click', () => loadReport(true));
elements.exportCsv.addEventListener('click', exportCurrentReport);
elements.search.addEventListener('input', renderCustomers);
loadReport(false);
