import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors";

export const COOKIE = "dof_session";
const MAX_BODY = 4 * 1024 * 1024; // Vercel allows about 4.5 MB for a request

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  ip: string;
  agent: string;
  origin: string; // this site's own address
  secure: boolean;
  cookies: Record<string, string>;
  body: Record<string, unknown>;
}

const header = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

function readStream(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, "That request is too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function readRequest(req: IncomingMessage): Promise<Req> {
  const host = header(req.headers["x-forwarded-host"]) || header(req.headers.host);
  const proto = header(req.headers["x-forwarded-proto"]).split(",")[0] || "http";
  const url = new URL(req.url ?? "/", `${proto}://${host}`);
  const method = (req.method ?? "GET").toUpperCase();
  const cookies: Record<string, string> = {};
  for (const part of header(req.headers.cookie).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  let body: Record<string, unknown> = {};
  if (method !== "GET" && method !== "HEAD") {
    const pre = (req as IncomingMessage & { body?: unknown }).body;
    const raw = pre !== undefined ? pre : await readStream(req);
    const parsed = typeof raw === "string" ? (raw ? JSON.parse(raw) : {}) : Buffer.isBuffer(raw) ? JSON.parse(raw.toString("utf8") || "{}") : raw;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    else if (parsed !== undefined && parsed !== null) throw new HttpError(400, "That request is not valid.");
  }
  const ip = header(req.headers["x-forwarded-for"]).split(",")[0].trim() || header(req.headers["x-real-ip"]) || req.socket?.remoteAddress || "";
  return { method, path: url.pathname.replace(/\/+$/, "") || "/", query: url.searchParams, headers: req.headers, ip, agent: header(req.headers["user-agent"]), origin: `${proto}://${host}`, secure: proto === "https", cookies, body };
}

/** Changes are only accepted from this site itself. Together with SameSite cookies this stops other sites acting for a signed-in person. */
export function assertSameSite(req: Req): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  if (!/^application\/json/i.test(header(req.headers["content-type"]))) throw new HttpError(415, "That request is not valid.");
  const origin = header(req.headers.origin);
  if (origin && origin !== req.origin) throw new HttpError(403, "That request came from another site.");
  if (!origin && header(req.headers["sec-fetch-site"]) === "cross-site") throw new HttpError(403, "That request came from another site.");
}

export function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function redirect(res: ServerResponse, to: string): void {
  res.statusCode = 302;
  res.setHeader("Location", to);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
export const clearCookie = (secure: boolean): string => sessionCookie("", secure, 0);
