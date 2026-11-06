import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "./config.ts";
import { q, q1, tx } from "./db.ts";

const EVENTS = ["message.received", "message.sent", "message.status", "message.failed", "message.edited", "message.deleted", "session.state"];
const MAX_ATTEMPTS = 8;

function privateAddress(ip: string) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// Webhooks must not be a way to reach internal services (SSRF). Checked when saving and again on every delivery.
export async function checkUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Invalid webhook URL."); }
  if (u.protocol !== "https:" && !(config.allowPrivateWebhooks && u.protocol === "http:")) throw new Error("The webhook URL must use https.");
  if (u.username || u.password) throw new Error("The webhook URL must not contain credentials.");
  if (config.allowPrivateWebhooks) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new Error("The webhook host does not resolve.");
  if (addresses.some(privateAddress)) throw new Error("The webhook URL points to a private address.");
  return u;
}

export async function createWebhook(url: string, events: unknown) {
  await checkUrl(url);
  const list = Array.isArray(events) ? events.map(String) : [];
  if (list.some((e) => !EVENTS.includes(e))) throw new Error(`Unknown event. Valid events: ${EVENTS.join(", ")}.`);
  const secret = randomBytes(24).toString("base64url");
  const w = await q1("insert into webhooks (url, secret, events) values ($1,$2,$3) returning id, url, events, active, created_at", [url, secret, list]);
  return { ...w, secret }; // the secret is returned only here
}

export const sign = (secret: string, body: string, timestamp: string) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

async function deliverOne() {
  const d = await tx(async (c) => {
    const r = (await c.query(
      `select d.*, w.url, w.secret from webhook_deliveries d join webhooks w on w.id=d.webhook_id
       where d.status='pending' and d.next_attempt_at <= now() order by d.id limit 1 for update of d skip locked`)).rows[0];
    if (r) await c.query("update webhook_deliveries set next_attempt_at = now() + interval '2 minutes' where id=$1", [r.id]); // lease
    return r;
  });
  if (!d) return false;
  let error: string | null = null;
  try {
    const url = await checkUrl(d.url);
    const body = JSON.stringify(d.payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), body,
      headers: { "content-type": "application/json", "x-webhook-event": d.event, "x-webhook-id": String(d.id), "x-webhook-timestamp": ts, "x-webhook-signature": sign(d.secret, body, ts) },
    });
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 200) : "error";
  }
  if (!error) await q("update webhook_deliveries set status='sent', attempts=attempts+1, last_error=null where id=$1", [d.id]);
  else if (d.attempts + 1 >= MAX_ATTEMPTS) await q("update webhook_deliveries set status='failed', attempts=attempts+1, last_error=$2 where id=$1", [d.id, error]);
  else await q("update webhook_deliveries set attempts=attempts+1, last_error=$2, next_attempt_at = now() + (interval '10 seconds' * power(3, attempts)) where id=$1", [d.id, error]);
  return true;
}

// Runs forever inside the api process; stop() ends it.
export function startDispatcher() {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try { if (await deliverOne()) continue; } catch (e) { console.error("webhook dispatcher:", e instanceof Error ? e.message : e); }
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return () => { stopped = true; };
}
export { deliverOne };
