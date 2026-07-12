// Minimal static file server with HTTP Basic Auth in front of it.
// Credentials come from Railway environment variables (GHOSTFLOW_USER / GHOSTFLOW_PASS)
// and are never sent to the client — this is server-side gating, not a client-side
// password screen (which could be extracted from the shipped JS bundle).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const PORT = process.env.PORT || 3000;
const USER = process.env.GHOSTFLOW_USER;
const PASS = process.env.GHOSTFLOW_PASS;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};

function checkAuth(req) {
  if (!USER || !PASS) return true; // no credentials configured — see README warning
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [u, p] = decoded.split(":");
  return u === USER && p === PASS;
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GHOSTFLOW"' });
    res.end("Authentication required");
    return;
  }

  let filePath = path.join(DIST_DIR, req.url === "/" ? "index.html" : req.url);
  if (!filePath.startsWith(DIST_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, "index.html"); // SPA fallback
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`GHOSTFLOW serving on port ${PORT}${!USER || !PASS ? " (WARNING: no auth configured — set GHOSTFLOW_USER/GHOSTFLOW_PASS)" : " (auth enabled)"}`);
});
