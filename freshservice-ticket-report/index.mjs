#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { getFreshserviceConfig } from "./src/config.mjs";
import { getReport, renderTable, renderCsv } from "./src/report.mjs";

// --- Configuration ---------------------------------------------------------
const { domain: DOMAIN, apiKey: API_KEY } = getFreshserviceConfig();

// --- CLI flags -------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const wantCsv = args.has("--csv");
const wantJson = args.has("--json");

async function main() {
  process.stderr.write("Fetching data from Freshservice...\n");
  const { rows } = await getReport({ domain: DOMAIN, apiKey: API_KEY });
  process.stderr.write(`  ${rows.length} customers with active tickets.\n\n`);

  if (wantJson) {
    const json = JSON.stringify(rows, null, 2);
    console.log(json);
    await writeFile(new URL("./report.json", import.meta.url), json);
    process.stderr.write("\nSaved report.json\n");
  } else if (wantCsv) {
    const csv = renderCsv(rows);
    console.log(csv);
    await writeFile(new URL("./report.csv", import.meta.url), csv);
    process.stderr.write("\nSaved report.csv\n");
  } else {
    console.log(renderTable(rows));
  }
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
