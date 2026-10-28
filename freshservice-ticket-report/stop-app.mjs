#!/usr/bin/env node
// Stops the report server by finding the node process listening on the app port
// and terminating it. Windows-focused (uses netstat + taskkill).
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);
const PORT = Number(process.env.PORT) || 3000;

async function findPids() {
  // Match lines like:  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   12345
  const { stdout } = await run(`netstat -ano -p tcp`);
  const pids = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (m && Number(m[1]) === PORT) pids.add(m[2]);
  }
  return [...pids];
}

async function main() {
  let pids = [];
  try {
    pids = await findPids();
  } catch (err) {
    console.error("Could not inspect ports:", err.message);
    process.exit(1);
  }

  if (pids.length === 0) {
    console.log(`No server found listening on port ${PORT}. Nothing to stop.`);
    return;
  }

  for (const pid of pids) {
    try {
      await run(`taskkill /PID ${pid} /F`);
      console.log(`Stopped server process (PID ${pid}) on port ${PORT}.`);
    } catch (err) {
      console.error(`Failed to stop PID ${pid}:`, err.message);
    }
  }
}

main();
