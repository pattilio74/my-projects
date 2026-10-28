import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile() {
  let contents;
  try {
    contents = readFileSync(resolve(APP_ROOT, '.env'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(name in process.env)) process.env[name] = value;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Add it to .env.`);
  return value;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

loadEnvFile();

const domain = (process.env.FRESHSERVICE_DOMAIN?.trim() || 'https://yourcompany.freshservice.com')
  .replace(/\/+$/, '');
const domainUrl = new URL(domain);
if (domainUrl.protocol !== 'https:') {
  throw new Error('FRESHSERVICE_DOMAIN must use HTTPS.');
}

export const config = Object.freeze({
  appRoot: APP_ROOT,
  publicDir: resolve(APP_ROOT, 'public'),
  domain,
  apiKey: required('FRESHSERVICE_API_KEY'),
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: parsePort(process.env.PORT || '3100'),
});
