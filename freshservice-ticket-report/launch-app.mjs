#!/usr/bin/env node
// Launcher: starts the report server (if not already running), waits until it
// responds, then opens the app in a frameless Edge/Chrome "app window".
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const URL = `http://127.0.0.1:${PORT}`;

// Candidate browser locations (Edge preferred, then Chrome).
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

async function isServerUp() {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startServer() {
  const child = spawn(process.execPath, [join(__dirname, "server.mjs")], {
    cwd: __dirname,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function findBrowser() {
  return BROWSERS.find((p) => existsSync(p));
}

function openAppWindow(browser) {
  // A dedicated user-data-dir keeps this app window isolated from your normal
  // browser profile so it behaves like a standalone app.
  const profileDir = join(__dirname, ".app-profile");
  const args = [`--app=${URL}`, `--user-data-dir=${profileDir}`, "--window-size=1200,850"];
  const child = spawn(browser, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function main() {
  const alreadyUp = await isServerUp();
  if (!alreadyUp) {
    console.log("Starting server...");
    startServer();
    const ok = await waitForServer();
    if (!ok) {
      console.error("Server did not start within the timeout. Check server.mjs.");
      process.exit(1);
    }
  }
  console.log("Server is up at " + URL);

  const browser = findBrowser();
  if (!browser) {
    console.error("Could not find Edge or Chrome. Open this URL manually: " + URL);
    process.exit(1);
  }
  console.log("Opening app window with " + browser.split("\\").pop());
  openAppWindow(browser);
  // Give the browser a moment to spawn before this launcher exits.
  setTimeout(() => process.exit(0), 1500);
}

main();
