import { readFileSync } from "node:fs";

const ENV_FILE = new URL("../.env", import.meta.url);
let environmentLoaded = false;

function loadLocalEnvironment() {
  if (environmentLoaded) return;
  environmentLoaded = true;

  let source;
  try {
    source = readFileSync(ENV_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function getFreshserviceConfig() {
  loadLocalEnvironment();

  const domain = (
    process.env.FRESHSERVICE_DOMAIN || "https://yourcompany.freshservice.com"
  ).replace(/\/+$/, "");
  const apiKey = process.env.FRESHSERVICE_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "FRESHSERVICE_API_KEY is required. Copy .env.example to .env and add your Freshservice API key."
    );
  }

  let parsedDomain;
  try {
    parsedDomain = new URL(domain);
  } catch {
    throw new Error("FRESHSERVICE_DOMAIN must be a valid URL.");
  }
  if (parsedDomain.protocol !== "https:") {
    throw new Error("FRESHSERVICE_DOMAIN must use HTTPS.");
  }

  return { domain, apiKey };
}
