import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { config } from './src/config.mjs';
import { FreshserviceClient } from './src/freshservice.mjs';
import { BASIS_OPTIONS, buildSlaReport, periodOptions, resolveBasis, resolvePeriod } from './src/sla.mjs';

const freshservice = new FreshserviceClient(config);
const CACHE_TTL_MS = 15 * 60 * 1_000;
const dataCache = new Map();
const reportCache = new Map();
const pending = new Map();

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8'),
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function getPeriodData(periodKey, forceRefresh) {
  const cached = dataCache.get(periodKey);
  if (!forceRefresh && cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.value;
  if (pending.has(periodKey)) return pending.get(periodKey);

  const request = (async () => {
    const period = resolvePeriod(periodKey);
    const [departments, tickets] = await Promise.all([
      freshservice.getDepartments(),
      freshservice.getTicketsUpdatedSince(period.from),
    ]);
    const value = { period, departments, tickets };
    dataCache.set(periodKey, { createdAt: Date.now(), value });
    return value;
  })();

  pending.set(periodKey, request);
  try {
    return await request;
  } finally {
    if (pending.get(periodKey) === request) pending.delete(periodKey);
  }
}

async function getSlaReport(periodKey, basisKey, forceRefresh) {
  const reportKey = `${periodKey}:${basisKey}`;
  if (forceRefresh) {
    dataCache.delete(periodKey);
    reportCache.delete(reportKey);
  }

  const cachedReport = reportCache.get(reportKey);
  const periodData = await getPeriodData(periodKey, forceRefresh);
  // Reuse a cached report only when it predates the current fetch.
  if (cachedReport && cachedReport.dataCreatedAt === dataCache.get(periodKey)?.createdAt) {
    return cachedReport.value;
  }

  const report = buildSlaReport({ ...periodData, basis: basisKey });
  reportCache.set(reportKey, {
    dataCreatedAt: dataCache.get(periodKey)?.createdAt,
    value: report,
  });
  return report;
}

async function sendStatic(response, pathname) {
  const entry = publicFiles.get(pathname);
  if (!entry) return false;

  const [filename, contentType] = entry;
  const filePath = resolve(config.publicDir, filename);
  const fileStats = await stat(filePath);
  response.writeHead(200, {
    ...securityHeaders(contentType),
    'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=300',
    'Content-Length': fileStats.size,
  });
  createReadStream(filePath).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok', periods: periodOptions, bases: BASIS_OPTIONS });
      return;
    }

    if (url.pathname === '/api/sla') {
      const periodKey = url.searchParams.get('period') || '30';
      if (!periodOptions.some(({ key }) => key === periodKey)) {
        sendJson(response, 400, { error: 'Period must be one of: 7, 30, 60, 3m, 6m.' });
        return;
      }
      const basisKey = resolveBasis(url.searchParams.get('basis'));
      const report = await getSlaReport(periodKey, basisKey, url.searchParams.get('refresh') === '1');
      sendJson(response, 200, report);
      return;
    }

    if (await sendStatic(response, url.pathname)) return;
    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    sendJson(response, status, { error: error.message || 'Unexpected server error.' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Freshservice Customer SLA Dashboard: http://${config.host}:${config.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
