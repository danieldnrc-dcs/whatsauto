// HTTP API. Dependency-free (node:http). Every /v1 route needs "Authorization: Bearer <api key>".
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { sha256 } from "./crypto.ts";
import { closeDb, q, q1 } from "./db.ts";
import * as svc from "./service.ts";
import { saveMedia, readMedia } from "./storage.ts";
import { createWebhook, startDispatcher } from "./webhooks.ts";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const JSON_LIMIT = 100_000;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(data);
}
async function readBody(req: IncomingMessage, limit: number) {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const p of req) {
    total += p.length;
    if (total > limit) throw new svc.HttpError(413, "Request too large.");
    parts.push(p);
  }
  return Buffer.concat(parts);
}
async function readJson(req: IncomingMessage) {
  const raw = (await readBody(req, JSON_LIMIT)).toString("utf8");
  if (!raw.trim()) return {} as Record<string, any>;
  try { const v = JSON.parse(raw); if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, any>; } catch { /* below */ }
  throw new svc.HttpError(400, "The body must be a JSON object.");
}

// Small in-memory rate limit per API key (per process).
const hits = new Map<string, { n: number; reset: number }>();
function limited(id: string) {
  const now = Date.now();
  const h = hits.get(id);
  if (!h || h.reset < now) { hits.set(id, { n: 1, reset: now + 60_000 }); return false; }
  return ++h.n > 300;
}

async function authenticate(req: IncomingMessage) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  if (!m) return null;
  const k = await q1("select id from api_keys where hash=$1 and revoked_at is null", [sha256(m[1])]);
  if (k) void q("update api_keys set last_used_at=now() where id=$1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [k.id]).catch(() => {});
  return k;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method || "GET";
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const sp = url.searchParams;
  let m: RegExpMatchArray | null;

  if (p === "/health") return send(res, 200, { ok: true });

  // Demo panel (static). It asks for an API key and calls the same API.
  if (method === "GET" && (p === "/" || p === "/index.html")) {
    const html = await readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'", "x-content-type-options": "nosniff" });
    return void res.end(html);
  }

  if (!p.startsWith("/v1/")) return send(res, 404, { error: "Not found." });
  const key = await authenticate(req);
  if (!key) return send(res, 401, { error: "Missing or invalid API key." }, { "www-authenticate": "Bearer" });
  if (limited(key.id)) return send(res, 429, { error: "Too many requests. Try again in a minute." }, { "retry-after": "60" });

  // sessions
  if (method === "GET" && p === "/v1/sessions") return send(res, 200, await svc.listSessions());
  if (method === "POST" && p === "/v1/sessions") return send(res, 201, await svc.createSession((await readJson(req)).name));
  if ((m = p.match(/^\/v1\/sessions\/(\d+)\/(connect|disconnect)$/)) && method === "POST") return send(res, 202, await svc.sessionCommand(m[1], m[2] as "connect" | "disconnect"));
  if ((m = p.match(/^\/v1\/sessions\/(\d+)\/qr$/)) && method === "GET") return send(res, 200, await svc.getQr(m[1]));

  // conversations
  if (method === "GET" && p === "/v1/conversations")
    return send(res, 200, await svc.listConversations({ session: sp.get("session") || undefined, limit: sp.get("limit"), before: sp.get("before"), external_ref: sp.get("external_ref") || undefined }));
  if ((m = p.match(/^\/v1\/conversations\/([^/]+)$/))) {
    if (method === "GET") return send(res, 200, await svc.getConversation(m[1]));
    if (method === "PATCH") return send(res, 200, await svc.updateConversation(m[1], await readJson(req)));
  }
  if ((m = p.match(/^\/v1\/conversations\/([^/]+)\/messages$/)) && method === "GET")
    return send(res, 200, await svc.listMessages(m[1], { limit: sp.get("limit"), before: sp.get("before") }));

  // messages
  if (method === "POST" && p === "/v1/messages") {
    const r = await svc.sendMessage(await readJson(req));
    return send(res, r.duplicate ? 200 : 202, r);
  }
  if ((m = p.match(/^\/v1\/messages\/([^/]+)\/edit$/)) && method === "POST") return send(res, 202, await svc.changeMessage(m[1], "edit", (await readJson(req)).text));
  if ((m = p.match(/^\/v1\/messages\/([^/]+)\/delete$/)) && method === "POST") return send(res, 202, await svc.changeMessage(m[1], "delete"));

  // media: upload the raw bytes (Content-Type = file type, ?name=file.ext), then use the id in POST /v1/messages
  if (method === "POST" && p === "/v1/media") {
    const data = await readBody(req, config.maxMediaBytes);
    return send(res, 201, await saveMedia(data, sp.get("name") || "file", String(req.headers["content-type"] || "")));
  }
  if ((m = p.match(/^\/v1\/media\/([^/]+)$/)) && method === "GET") {
    const f = await readMedia(svc.uuid(m[1]));
    if (!f) return send(res, 404, { error: "Media not found." });
    res.writeHead(200, {
      "content-type": f.meta.mime, "content-length": String(f.data.length), "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`, "content-security-policy": "sandbox", "cache-control": "private, max-age=3600",
    });
    return void res.end(f.data);
  }

  // webhooks
  if (method === "GET" && p === "/v1/webhooks") return send(res, 200, await q("select id,url,events,active,created_at from webhooks order by created_at"));
  if (method === "POST" && p === "/v1/webhooks") { const b = await readJson(req); return send(res, 201, await createWebhook(String(b.url ?? ""), b.events)); }
  if ((m = p.match(/^\/v1\/webhooks\/([^/]+)$/)) && method === "DELETE") {
    await q("delete from webhooks where id=$1", [svc.uuid(m[1])]);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Not found." });
}

export function createApi() {
  return createServer((req, res) => {
    route(req, res, new URL(req.url || "/", "http://localhost")).catch((e) => {
      if (e instanceof svc.HttpError) return send(res, e.status, { error: e.message });
      console.error("api error:", e instanceof Error ? e.message : e);
      if (!res.headersSent) send(res, 500, { error: "Internal error." });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  config.secret; // fail early when misconfigured
  const stop = startDispatcher();
  const server = createApi().listen(config.port, () => console.log(`API and demo panel on http://localhost:${config.port}`));
  const bye = () => { stop(); server.close(); void closeDb().finally(() => process.exit(0)); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
