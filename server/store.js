// Simple JSON-file trade storage.
//
// IMPORTANT: Railway's default filesystem is EPHEMERAL. This file gets wiped
// on every redeploy. This is fine for now (testing the data pipeline) but
// before relying on this for real, ongoing trade logging, this needs to move
// to a real database (or a Railway volume) so trades survive a redeploy.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, "[]");
}

export function readTrades() {
  ensureStore();
  return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
}

export function appendTrade(trade) {
  const trades = readTrades();
  trades.unshift(trade); // newest first
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  return trade;
}
