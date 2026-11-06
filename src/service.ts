// Business rules shared by the HTTP API (and usable directly if you embed this code in your own app).
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { decrypt } from "./crypto.ts";
import { q, q1, tx } from "./db.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const bad = (m: string) => new HttpError(400, m);
const notFound = (m: string) => new HttpError(404, m);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v: unknown, what = "id") {
  if (typeof v !== "string" || !UUID.test(v)) throw bad(`Invalid ${what}.`);
  return v;
}
const sessionId = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw bad("Invalid session.");
  return n;
};

// Digits only, with country code (e.g. 5511999990000). Whether the number really has WhatsApp is checked by
// the worker before the first message, which also resolves variations such as a missing ninth digit in Brazil.
export function normalizePhone(input: unknown) {
  let d = String(input ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length < 8 || d.length > 15) throw bad("Invalid phone number. Use country code + area code + number, digits only.");
  return d;
}

// ---- sessions (WhatsApp numbers)
export async function listSessions() {
  const rows = await q("select id,name,phone,state,desired,lease_until > now() as worker_online,updated_at from sessions order by id");
  return rows;
}
export async function createSession(name: unknown) {
  const n = String(name ?? "").trim().slice(0, 60);
  if (!n) throw bad("Give the session a name.");
  return q1("insert into sessions (name) values ($1) returning id,name,state", [n]);
}
export async function sessionCommand(id: unknown, command: "connect" | "disconnect") {
  const sid = sessionId(id);
  const r = await q1("update sessions set command=$2, desired=$3 where id=$1 returning id,state", [sid, command, command === "connect"]);
  if (!r) throw notFound("Session not found.");
  return { ok: true, note: "The worker for this session picks the command up within a few seconds." };
}
export async function getQr(id: unknown) {
  const s = await q1("select state,qr,qr_expires_at,lease_until > now() as worker_online from sessions where id=$1", [sessionId(id)]);
  if (!s) throw notFound("Session not found.");
  const valid = s.qr && s.qr_expires_at && new Date(s.qr_expires_at) > new Date();
  const qr = valid ? decrypt(s.qr) : null;
  return { state: s.state, worker_online: !!s.worker_online, qr, qr_png: qr ? await QRCode.toDataURL(qr, { margin: 2, width: 320 }) : null };
}

// ---- conversations and messages
export async function listConversations(o: { session?: unknown; limit?: unknown; before?: unknown; external_ref?: unknown }) {
  const limit = Math.min(Math.max(Number(o.limit) || 30, 1), 100);
  const before = o.before ? new Date(String(o.before)) : null;
  if (before && Number.isNaN(before.getTime())) throw bad("Invalid 'before'.");
  return q(
    `select c.id,c.session_id,c.jid,c.phone,c.name,c.external_ref,c.metadata,c.last_message_at,c.created_at,
        (select left(body,140) from messages m where m.conversation_id=c.id order by m.sent_at desc,m.id desc limit 1) preview
       from conversations c
      where ($1::int is null or c.session_id=$1) and ($2::text is null or c.external_ref=$2)
        and ($3::timestamptz is null or c.last_message_at < $3)
      order by c.last_message_at desc nulls last, c.id limit $4`,
    [o.session ? sessionId(o.session) : null, o.external_ref ? String(o.external_ref) : null, before, limit]);
}
export async function getConversation(id: unknown) {
  const c = await q1("select * from conversations where id=$1", [uuid(id)]);
  if (!c) throw notFound("Conversation not found.");
  return c;
}
export async function updateConversation(id: unknown, d: { external_ref?: unknown; metadata?: unknown; name?: unknown }) {
  const cid = uuid(id);
  if (d.metadata !== undefined && (typeof d.metadata !== "object" || d.metadata === null || Array.isArray(d.metadata) || JSON.stringify(d.metadata).length > 8000))
    throw bad("'metadata' must be an object of at most 8 KB.");
  const r = await q1(
    `update conversations set external_ref = case when $2::boolean then $3 else external_ref end,
        metadata = coalesce($4::jsonb, metadata), name = coalesce($5, name), updated_at = now()
      where id=$1 returning *`,
    [cid, d.external_ref !== undefined, d.external_ref === null ? null : String(d.external_ref ?? "").slice(0, 200),
     d.metadata === undefined ? null : JSON.stringify(d.metadata), d.name === undefined ? null : String(d.name).slice(0, 180)]);
  if (!r) throw notFound("Conversation not found.");
  return r;
}
export async function listMessages(conversationId: unknown, o: { limit?: unknown; before?: unknown }) {
  const cid = uuid(conversationId);
  const limit = Math.min(Math.max(Number(o.limit) || 50, 1), 200);
  const before = o.before ? new Date(String(o.before)) : null;
  if (before && Number.isNaN(before.getTime())) throw bad("Invalid 'before'.");
  const rows = await q(
    `select m.id,m.external_id,m.direction,m.body,m.status,m.error,m.author_name,m.sent_at,m.edited_at,m.original_body,m.deleted_at,
            m.change_type,m.change_status,m.change_error,
            m.media_id, a.name media_name, a.mime media_mime, a.size media_size,
            (${canChange("delete")}) can_delete, (${canChange("edit")}) can_edit
       from messages m left join media a on a.id=m.media_id
      where m.conversation_id=$1 and ($2::timestamptz is null or m.sent_at < $2)
      order by m.sent_at desc, m.id desc limit $3`, [cid, before, limit]);
  return rows.reverse();
}

// WhatsApp only lets you edit within 15 minutes and delete for everyone within about 2 days.
const EDIT_WINDOW = "interval '15 minutes'", DELETE_WINDOW = "interval '2 days'";
function canChange(kind: "edit" | "delete") {
  return `m.direction in ('out','out_phone') and m.external_id is not null and m.deleted_at is null
    and m.status in ('sent','delivered','read') and coalesce(m.change_status,'') not in ('queued','running')
    ${kind === "edit" ? `and m.direction='out' and m.media_id is null and m.sent_at > now() - ${EDIT_WINDOW}` : `and m.sent_at > now() - ${DELETE_WINDOW}`}`;
}

export async function sendMessage(d: {
  session?: unknown; to?: unknown; conversation?: unknown; text?: unknown; media_id?: unknown; idempotency_key?: unknown; author_name?: unknown;
}) {
  const text = d.text === undefined || d.text === null ? "" : String(d.text);
  if (text.length > 4000) throw bad("Text longer than 4000 characters.");
  const mediaId = d.media_id ? uuid(d.media_id, "media_id") : null;
  if (!text.trim() && !mediaId) throw bad("Provide 'text' or 'media_id'.");
  const key = d.idempotency_key === undefined ? randomUUID() : String(d.idempotency_key);
  if (key.length < 8 || key.length > 120) throw bad("'idempotency_key' must have 8 to 120 characters.");
  const author = d.author_name ? String(d.author_name).slice(0, 80) : null;

  return tx(async (c) => {
    const again = (await c.query("select id,conversation_id,status from messages where idempotency_key=$1", [key])).rows[0];
    if (again) return { id: again.id, conversation_id: again.conversation_id, status: again.status, duplicate: true };
    if (mediaId && !(await c.query("select 1 from media where id=$1", [mediaId])).rows.length) throw notFound("Media not found.");
    let conv;
    if (d.conversation) {
      conv = (await c.query("select id,session_id from conversations where id=$1 for update", [uuid(d.conversation, "conversation")])).rows[0];
      if (!conv) throw notFound("Conversation not found.");
    } else {
      const sid = sessionId(d.session ?? 1);
      if (!(await c.query("select 1 from sessions where id=$1", [sid])).rows.length) throw notFound("Session not found.");
      const phone = normalizePhone(d.to);
      conv = (await c.query("select id,session_id from conversations where session_id=$1 and phone=$2 order by last_message_at desc nulls last limit 1", [sid, phone])).rows[0]
        ?? (await c.query(
          `insert into conversations (session_id,jid,phone,name,last_message_at) values ($1,$2,$3,$3,now())
           on conflict (session_id,jid) do update set updated_at=now() returning id,session_id`, [sid, `${phone}@s.whatsapp.net`, phone])).rows[0];
    }
    const m = (await c.query(
      `insert into messages (conversation_id,direction,body,media_id,status,idempotency_key,author_name)
       values ($1,'out',$2,$3,'queued',$4,$5) returning id,status`, [conv.id, text.trim(), mediaId, key, author])).rows[0];
    await c.query("update conversations set last_message_at=now(), updated_at=now() where id=$1", [conv.id]);
    return { id: m.id, conversation_id: conv.id, status: m.status, duplicate: false };
  });
}

export async function changeMessage(id: unknown, kind: "edit" | "delete", text?: unknown) {
  const mid = uuid(id, "message id");
  let body: string | null = null;
  if (kind === "edit") {
    body = String(text ?? "").trim();
    if (!body) throw bad("Provide the new 'text'.");
    if (body.length > 4000) throw bad("Text longer than 4000 characters.");
  }
  const r = await q1(
    `update messages m set change_type=$2, change_body=$3, change_status='queued', change_error=null, change_at=now(), updated_at=now()
      where m.id=$1 and (${canChange(kind)}) returning m.id`, [mid, kind, body]);
  if (!r) {
    if (!(await q1("select 1 from messages where id=$1", [mid]))) throw notFound("Message not found.");
    throw new HttpError(409, kind === "edit"
      ? "This message can no longer be edited (only text you sent, within 15 minutes, with no change in progress)."
      : "This message can no longer be deleted for everyone (within 2 days, with no change in progress).");
  }
  return { ok: true, status: "queued" };
}
