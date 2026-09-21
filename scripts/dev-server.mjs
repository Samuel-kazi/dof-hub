// Try the whole app on your own computer, the way Vercel will run it:  npm run build  then  npm run dev:server
// Data is kept in memory (gone when you stop it) unless MONGODB_URI is set in a file named .env.local.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (existsSync(join(root, ".env.local"))) {
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!process.env.MONGODB_URI) process.env.DOF_STORE = "memory";
process.env.SETUP_TOKEN ??= "local-setup-code";

const { handler } = await import("../api/_server.mjs");
const headers = Object.fromEntries((JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).headers[0].headers).map((h) => [h.key, h.value]));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const dist = join(root, "dist");
const port = Number(process.env.PORT ?? 4173);

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (path.startsWith("/api/")) return handler(req, res);
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
}).listen(port, () => {
  console.log(`\nOpen http://localhost:${port}`);
  console.log(process.env.DOF_STORE === "memory" ? "Data is kept in memory and is lost when you stop this." : "Using MongoDB.");
  console.log(`First-time setup code: ${process.env.SETUP_TOKEN}\n`);
});
