#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { getFreshserviceConfig } from "./src/config.mjs";
import { getReport, getTeamSlaReport, renderCsv, renderSummaryCsv } from "./src/report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

// --- Configuration ---------------------------------------------------------
const { domain: DOMAIN, apiKey: API_KEY } = getFreshserviceConfig();
const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";

// Cache the main report briefly; cache historical SLA ranges longer because
// embedded ticket statistics consume additional Freshservice API credits.
const CACHE_TTL_MS = 60_000;
const SLA_CACHE_TTL_MS = 30 * 60_000;
const SLA_PERIODS = new Set(["7", "30", "60", "3m", "6m"]);
let cache = { at: 0, data: null };
const slaCache = new Map();
const slaInflight = new Map();

async function loadReport({ force = false } = {}) {
  const fresh = Date.now() - cache.at < CACHE_TTL_MS && cache.data;
  if (fresh && !force) return cache.data;
  const data = await getReport({ domain: DOMAIN, apiKey: API_KEY });
  // Expose the domain so the frontend can build ticket deep-links.
  data.domain = DOMAIN;
  cache = { at: Date.now(), data };
  return data;
}

async function loadTeamSla(period, { force = false } = {}) {
  const cached = slaCache.get(period);
  if (!force && cached && Date.now() - cached.at < SLA_CACHE_TTL_MS) return cached.data;
  if (!force && slaInflight.has(period)) return slaInflight.get(period);

  const request = getTeamSlaReport({ domain: DOMAIN, apiKey: API_KEY, period })
    .then((data) => {
      slaCache.set(period, { at: Date.now(), data });
      return data;
    })
    .finally(() => slaInflight.delete(period));
  slaInflight.set(period, request);
  return request;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  // Resolve safely within PUBLIC_DIR to avoid path traversal.
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (path === "/api/sla") {
      const period = (url.searchParams.get("period") || "7").toLowerCase();
      if (!SLA_PERIODS.has(period)) {
        return sendJson(res, 400, { error: "Invalid SLA period. Use 7, 30, 60, 3m, or 6m." });
      }
      const force = url.searchParams.get("refresh") === "1";
      const data = await loadTeamSla(period, { force });
      return sendJson(res, 200, data);
    }

    if (path === "/api/report") {
      const force = url.searchParams.get("refresh") === "1";
      const data = await loadReport({ force });
      return sendJson(res, 200, data);
    }

    if (path === "/api/report.csv") {
      const data = await loadReport();
      const csv = renderCsv(data.rows);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="freshservice-tickets.csv"',
      });
      return res.end(csv);
    }

    if (path === "/api/report.summary.csv") {
      const data = await loadReport();
      const csv = renderSummaryCsv(data.rows);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="freshservice-summary.csv"',
      });
      return res.end(csv);
    }

    if (path.startsWith("/api/")) {
      return sendJson(res, 404, { error: "Unknown endpoint" });
    }

    return await serveStatic(res, path);
  } catch (err) {
    console.error("Request error:", err.message);
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Freshservice ticket report running at http://${HOST}:${PORT}`);
  console.log(`Using domain: ${DOMAIN}`);
});
