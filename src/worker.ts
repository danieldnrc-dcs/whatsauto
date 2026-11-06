// WhatsApp worker for ONE number (session). Run one process per session: SESSION_ID=1 npm run worker.
// It keeps the connection (pairing by QR code), stores what arrives, sends what the API queued,
// applies edits/deletes and announces everything through webhooks.
import makeWASocket, {
  BufferJSON, DisconnectReason, downloadMediaMessage, initAuthCreds, jidNormalizedUser,
  makeCacheableSignalKeyStore, normalizeMessageContent, proto,
} from "@whiskeysockets/baileys";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { closeDb, q, q1, tx } from "./db.ts";
import { emit } from "./events.ts";
import { saveMedia } from "./storage.ts";

const SESSION = config.sessionId;
const WORKER = randomUUID();
config.secret; // fail early when misconfigured
const logger = pino({ level: "silent" }); // protocol logs can contain numbers, messages and keys

let sock: WASocket | undefined;
let connected = false, desired = false, connecting = false, stopping = false;
let nextTry = 0, attempts = 0, lastLease = 0, qrAt = 0, lastSend = 0, currentState = "";
let events: Promise<void> = Promise.resolve();

// Socket events are processed one at a time, in order.
function serial(fn: () => Promise<void>) {
  events = events.then(fn).catch((e) => console.error("worker: failed to persist an event:", e instanceof Error ? e.message : e));
}

async function setState(state: string, qr: string | null = null) {
  await q(
    `update sessions set state=$2, qr=$3, qr_expires_at = case when $3::text is null then null else now() + interval '60 seconds' end, updated_at=now()
      where id=$4 and worker_id=$1`, [WORKER, state, qr ? encrypt(qr) : null, SESSION]);
  if (state !== currentState && state !== "qr") await emit("session.state", { session_id: SESSION, state });
  if (state !== "qr") currentState = state; else currentState = "qr";
}

async function takeLease() {
  const r = await q1(
    `update sessions set worker_id=$1, lease_until = now() + interval '45 seconds'
      where id=$2 and (worker_id=$1 or lease_until is null or lease_until < now()) returning id`, [WORKER, SESSION]);
  if (!r) throw new Error(`Session ${SESSION} does not exist or another worker is serving it.`);
  lastLease = Date.now();
}

// Baileys credentials and keys live in the database, encrypted.
async function authState() {
  const read = async (key: string) => {
    const r = await q1("select value from auth_state where session_id=$1 and key=$2", [SESSION, key]);
    return r ? JSON.parse(decrypt(r.value), BufferJSON.reviver) : null;
  };
  const write = (key: string, value: unknown) =>
    q(`insert into auth_state (session_id,key,value) values ($1,$2,$3) on conflict (session_id,key) do update set value=excluded.value`,
      [SESSION, key, encrypt(JSON.stringify(value, BufferJSON.replacer))]);
  const creds = (await read("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const out: Record<string, any> = {};
          for (const id of ids) {
            let v = await read(`${type}:${id}`);
            if (type === "app-state-sync-key" && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }
          return out;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          await tx(async (c) => {
            for (const [type, items] of Object.entries(data))
              for (const [id, v] of Object.entries(items)) {
                if (v) await c.query(`insert into auth_state (session_id,key,value) values ($1,$2,$3) on conflict (session_id,key) do update set value=excluded.value`,
                  [SESSION, `${type}:${id}`, encrypt(JSON.stringify(v, BufferJSON.replacer))]);
                else await c.query("delete from auth_state where session_id=$1 and key=$2", [SESSION, `${type}:${id}`]);
              }
          });
        },
      },
    },
    saveCreds: (update?: object) => { if (update) Object.assign(creds, update); return write("creds", creds); },
  };
}

// ---------------------------------------------------------------- inbound
const IGNORED = ["senderKeyDistributionMessage", "pinInChatMessage", "keepInChatMessage", "albumMessage", "pollUpdateMessage", "encReactionMessage", "messageContextInfo", "botInvokeMessage"];
const vcardPhone = (v?: string) => { const t = v?.match(/waid=(\d{8,15})/)?.[1] || v?.match(/TEL[^:\n]*:([+\d\s()-]{8,})/)?.[1]?.trim(); return t ? ` (${t})` : ""; };
const SPECIAL: [string, (x: any) => string][] = [
  ["reactionMessage", (x) => (x.text ? `[Reacted with ${x.text}]` : "[Removed a reaction]")],
  ["locationMessage", (x) => `[Location${x.name ? `: ${x.name}` : ""}] https://maps.google.com/?q=${x.degreesLatitude},${x.degreesLongitude}`],
  ["liveLocationMessage", (x) => `[Live location] https://maps.google.com/?q=${x.degreesLatitude},${x.degreesLongitude}`],
  ["contactMessage", (x) => `[Contact] ${x.displayName || ""}${vcardPhone(x.vcard)}`],
  ["contactsArrayMessage", (x) => `[Contacts] ${(x.contacts || []).map((c: any) => `${c.displayName || ""}${vcardPhone(c.vcard)}`).join("; ")}`],
  ["pollCreationMessage", (x) => `[Poll] ${x.name || ""}: ${(x.options || []).map((o: any) => o.optionName).join(" / ")}`],
  ["pollCreationMessageV3", (x) => `[Poll] ${x.name || ""}: ${(x.options || []).map((o: any) => o.optionName).join(" / ")}`],
  ["buttonsResponseMessage", (x) => x.selectedDisplayText || ""],
  ["listResponseMessage", (x) => x.title || ""],
  ["templateButtonReplyMessage", (x) => x.selectedDisplayText || ""],
  ["interactiveResponseMessage", (x) => x.body?.text || ""],
];
const when = (m: WAMessage) => {
  const s = Number(m.messageTimestamp?.toString());
  const d = new Date(s * 1000);
  return Number.isFinite(s) && s > 946684800 && d.getTime() < Date.now() + 86_400_000 ? d : new Date();
};
const digitsOf = (jid: string) => (jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : null);

async function conversationFor(jid: string, name: string | null) {
  const phone = digitsOf(jid);
  return (await q1(
    `insert into conversations (session_id,jid,phone,name) values ($1,$2,$3,$4)
     on conflict (session_id,jid) do update set
       name = case when $5::text is not null and (conversations.name = '' or conversations.name = conversations.phone) then $5 else conversations.name end,
       updated_at = now()
     returning *`, [SESSION, jid, phone, name || phone || "WhatsApp contact", name]))!;
}

async function receive(m: WAMessage) {
  const rawJid = m.key.remoteJid;
  if (!rawJid || !m.key.id || !m.message) return;
  const isGroup = rawJid.endsWith("@g.us");
  if (!(isGroup ? config.includeGroups : /@(s\.whatsapp\.net|lid)$/.test(rawJid))) return;
  const jid = isGroup ? rawJid : jidNormalizedUser(rawJid);
  const content = normalizeMessageContent(m.message);
  if (!content) return;

  // The other side deleted or edited a message: keep our record and mark what happened.
  const proto_ = content.protocolMessage;
  if (proto_) {
    const kind = Number(proto_.type);
    const target = proto_.key?.id;
    const conv = target ? await q1("select id from conversations where session_id=$1 and jid=$2", [SESSION, jid]) : null;
    if (!conv || !target) return;
    if (kind === proto.Message.ProtocolMessage.Type.REVOKE) {
      const r = await q1("update messages set deleted_at=coalesce(deleted_at,now()), updated_at=now() where conversation_id=$1 and external_id=$2 returning id", [conv.id, target]);
      if (r) await emit("message.deleted", { session_id: SESSION, conversation_id: conv.id, message_id: r.id, external_id: target });
    } else if (kind === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && proto_.editedMessage) {
      const e = normalizeMessageContent(proto_.editedMessage);
      const body = e?.conversation || e?.extendedTextMessage?.text || e?.imageMessage?.caption || e?.videoMessage?.caption || "";
      if (!body) return;
      const r = await q1(`update messages set original_body=coalesce(original_body,body), body=$3, edited_at=now(), updated_at=now()
        where conversation_id=$1 and external_id=$2 returning id`, [conv.id, target, body.slice(0, 30000)]);
      if (r) await emit("message.edited", { session_id: SESSION, conversation_id: conv.id, message_id: r.id, external_id: target, body });
    }
    return;
  }
  if (!Object.keys(content).some((k) => !IGNORED.includes(k))) return;

  const fromMe = !!m.key.fromMe;
  if (await q1("select 1 from messages x join conversations c on c.id=x.conversation_id where c.session_id=$1 and c.jid=$2 and x.external_id=$3", [SESSION, jid, m.key.id])) return;

  const media: any = content.imageMessage || content.audioMessage || content.videoMessage || content.documentMessage || content.stickerMessage;
  let body = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || content.documentMessage?.caption || "";
  if (!body) for (const [k, f] of SPECIAL) if ((content as any)[k]) { body = f((content as any)[k]).trim(); if (body) break; }
  let mediaId: string | null = null;
  if (media) {
    if (Number(media.fileLength || 0) > config.maxMediaBytes) body += `${body ? "\n" : ""}[File larger than ${config.maxMediaBytes / 1024 / 1024} MB was not downloaded]`;
    else {
      try {
        const data = (await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: sock!.updateMediaMessage })) as Buffer;
        mediaId = (await saveMedia(data, media.fileName || (content.stickerMessage ? "sticker.webp" : "file"), media.mimetype || "")).id;
      } catch (e) {
        console.error("worker: media download failed:", e instanceof Error ? e.message : "error");
        body += `${body ? "\n" : ""}[The file could not be downloaded]`;
      }
    }
  }
  if (!body && !mediaId) body = "[Unsupported message type]";

  const conv = await conversationFor(jid, fromMe ? null : m.pushName || null);
  const at = when(m);
  const row = await q1(
    `insert into messages (conversation_id,external_id,direction,body,media_id,status,sent_at)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (conversation_id,external_id) do nothing returning id`,
    [conv.id, m.key.id, fromMe ? "out_phone" : "in", body.slice(0, 30000), mediaId, fromMe ? "sent" : "received", at]);
  if (!row) return;
  await q("update conversations set last_message_at=greatest(coalesce(last_message_at,$2),$2), updated_at=now() where id=$1", [conv.id, at]);
  await emit(fromMe ? "message.sent" : "message.received", {
    session_id: SESSION,
    conversation: { id: conv.id, jid: conv.jid, phone: conv.phone, name: conv.name, external_ref: conv.external_ref },
    message: { id: row.id, external_id: m.key.id, direction: fromMe ? "out_phone" : "in", body, media_id: mediaId, sent_at: at.toISOString() },
  });
}

// ---------------------------------------------------------------- outbound
async function sendNext() {
  if (!connected || !sock || Date.now() - lastLease > 30_000) return;
  if (Date.now() - lastSend < config.sendDelayMs) return; // pace the number: bursts get numbers blocked
  const m = await tx(async (c) => {
    const r = (await c.query(
      `select m.*, c.jid, c.jid_verified from messages m join conversations c on c.id=m.conversation_id
        where m.status='queued' and c.session_id=$1 order by m.sent_at, m.id limit 1 for update of m skip locked`, [SESSION])).rows[0];
    if (!r) return null;
    await c.query("update messages set status='sending', external_id=$2, updated_at=now() where id=$1", [r.id, r.id.replaceAll("-", "").toUpperCase()]);
    return r;
  });
  if (!m) return;
  lastSend = Date.now();
  const fail = async (status: "failed" | "uncertain", error: string) => {
    await q("update messages set status=$2, error=$3, updated_at=now() where id=$1", [m.id, status, error]);
    await emit("message.failed", { session_id: SESSION, conversation_id: m.conversation_id, message_id: m.id, status, error });
  };
  let jid: string = m.jid;
  if (!m.jid_verified && jid.endsWith("@s.whatsapp.net")) {
    // Confirms the number has WhatsApp and uses the identifier WhatsApp returns (e.g. a missing ninth digit in Brazil).
    const [found] = (await sock.onWhatsApp(jid.split("@")[0]).catch(() => undefined)) || [];
    if (!found?.exists) return fail("failed", "This number is not on WhatsApp. Check the phone number.");
    const real = jidNormalizedUser(found.jid);
    const free = real === jid || !(await q1("select 1 from conversations where session_id=$1 and jid=$2", [SESSION, real]));
    await q("update conversations set jid=case when $3 then $2 else jid end, phone=case when $3 then $4 else phone end, jid_verified=true where id=$1",
      [m.conversation_id, real, free, digitsOf(real)]);
    jid = free ? real : jid;
  }
  try {
    const id = m.id.replaceAll("-", "").toUpperCase();
    let content: any = { text: m.body };
    if (m.media_id) {
      const a = await q1("select * from media where id=$1", [m.media_id]);
      if (!a) return fail("failed", "File not found.");
      const data = await readFile(path.join(config.mediaDir, a.storage_key));
      if (a.mime.startsWith("audio/")) {
        if (m.body) await sock.sendMessage(jid, { text: m.body }, { messageId: `${id}A` }); // audio cannot carry a caption
        const voice = a.mime === "audio/ogg";
        content = { audio: data, mimetype: voice ? "audio/ogg; codecs=opus" : a.mime, ptt: voice };
      } else if (a.mime.startsWith("image/")) content = { image: data, mimetype: a.mime, caption: m.body };
      else if (a.mime.startsWith("video/")) content = { video: data, mimetype: a.mime, caption: m.body };
      else content = { document: data, mimetype: a.mime, fileName: a.name, caption: m.body };
    }
    await sock.sendMessage(jid, content, { messageId: id });
    await q("update messages set status=case when status in ('delivered','read') then status else 'sent' end, updated_at=now() where id=$1", [m.id]);
    await emit("message.sent", { session_id: SESSION, conversation_id: m.conversation_id, message: { id: m.id, external_id: id, direction: "out", body: m.body, media_id: m.media_id } });
  } catch {
    // A network failure can happen AFTER delivery: never retry automatically.
    await fail("uncertain", "No confirmation of delivery. Check on the phone before sending again.");
  }
}

// Edits and deletes requested through the API.
async function applyChange() {
  if (!connected || !sock) return;
  await q(
    `update messages m set change_status='failed', change_error='The number was offline and the request expired. Try again.'
      from conversations c where c.id=m.conversation_id and c.session_id=$1 and m.change_status='queued' and m.change_at < now() - interval '5 minutes'`, [SESSION]);
  const m = await q1(
    `update messages set change_status='running' where id=(
       select x.id from messages x join conversations c on c.id=x.conversation_id
        where x.change_status='queued' and c.session_id=$1 order by x.change_at limit 1 for update of x skip locked)
     returning id, conversation_id, external_id, change_type, change_body`, [SESSION]);
  if (!m) return;
  const jid = (await q1("select jid from conversations where id=$1", [m.conversation_id]))!.jid;
  const key = { remoteJid: jid, fromMe: true, id: m.external_id };
  try {
    if (m.change_type === "delete") {
      await sock.sendMessage(jid, { delete: key });
      await q("update messages set deleted_at=now(), change_type=null, change_body=null, change_status=null, change_error=null, updated_at=now() where id=$1", [m.id]);
      await emit("message.deleted", { session_id: SESSION, conversation_id: m.conversation_id, message_id: m.id, external_id: m.external_id });
    } else {
      await sock.sendMessage(jid, { text: m.change_body, edit: key });
      await q(`update messages set original_body=coalesce(original_body,body), body=$2, edited_at=now(), change_type=null, change_body=null, change_status=null, change_error=null, updated_at=now() where id=$1`, [m.id, m.change_body]);
      await emit("message.edited", { session_id: SESSION, conversation_id: m.conversation_id, message_id: m.id, external_id: m.external_id, body: m.change_body });
    }
  } catch {
    await q("update messages set change_status='failed', change_error='WhatsApp did not confirm. Check on the phone before trying again.', updated_at=now() where id=$1", [m.id]);
  }
}

// ---------------------------------------------------------------- connection
async function connect() {
  if (connecting || stopping) return;
  connecting = true;
  try {
    await setState("connecting");
    const a = await authState();
    const s = makeWASocket({
      auth: { creds: a.state.creds, keys: makeCacheableSignalKeyStore(a.state.keys as any, logger) },
      logger, markOnlineOnConnect: false, syncFullHistory: false,
      connectTimeoutMs: 30_000, defaultQueryTimeoutMs: 30_000, keepAliveIntervalMs: 20_000,
      // When the other phone cannot open one of our messages it asks for a resend; we return the text.
      getMessage: async (key) => {
        const r = key.id ? await q1(`select m.body from messages m join conversations c on c.id=m.conversation_id
          where c.session_id=$1 and m.external_id=$2 and m.direction='out' and m.media_id is null`, [SESSION, key.id]) : null;
        return r?.body ? proto.Message.fromObject({ conversation: r.body }) : undefined;
      },
    });
    sock = s;
    s.ev.on("creds.update", (u) => serial(async () => { await a.saveCreds(u); }));
    s.ev.on("messages.upsert", ({ messages, type }) => {
      if (type === "notify" || type === "append")
        for (const m of messages) serial(() => receive(m));
    });
    s.ev.on("messages.update", (updates) => serial(async () => {
      for (const { key, update } of updates) {
        const status = Number(update.status);
        if (!key.id || !(status >= 3)) continue;
        const next = status >= 4 ? "read" : "delivered";
        const r = await q1(`update messages set status=$2, updated_at=now() where external_id=$1 and direction='out'
          and (status in ('sending','sent','uncertain') or (status='delivered' and $2='read')) returning id, conversation_id`, [key.id, next]);
        if (r) await emit("message.status", { session_id: SESSION, conversation_id: r.conversation_id, message_id: r.id, external_id: key.id, status: next });
      }
    }));
    s.ev.on("connection.update", (u) => serial(async () => {
      if (sock !== s || stopping) return;
      if (u.qr) { qrAt = Date.now(); await setState("qr", u.qr); }
      if (u.connection === "open") {
        connected = true; qrAt = 0; attempts = 0;
        await setState("connected");
        const number = (s.user?.id || "").split(/[:@]/)[0];
        if (/^\d{8,15}$/.test(number)) await q("update sessions set phone=$2 where id=$3 and worker_id=$1", [WORKER, number, SESSION]);
        console.log("worker: WhatsApp connected.");
      }
      if (u.connection === "close") {
        connected = false; qrAt = 0; sock = undefined;
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        console.error(`worker: connection closed (code ${Number.isInteger(code) ? code : "unknown"}).`);
        if (code === DisconnectReason.loggedOut) {
          // Unlinked from the phone: forget the credentials, a new QR code is needed.
          desired = false;
          await q("delete from auth_state where session_id=$1", [SESSION]);
          await q("update sessions set desired=false, phone=null where id=$1 and worker_id=$2", [SESSION, WORKER]);
          await setState("disconnected");
        } else {
          attempts++;
          nextTry = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)) + Math.random() * 1000;
          await setState("reconnecting");
        }
      }
    }));
  } finally {
    connecting = false;
  }
}

async function tick() {
  try {
    if (Date.now() - lastLease > 10_000) await takeLease();
    const cmd = await q1(
      `with pending as materialized (select command from sessions where id=$1 and worker_id=$2 and command is not null for update)
       update sessions s set command=null from pending p where s.id=$1 and s.worker_id=$2 returning p.command`, [SESSION, WORKER]);
    if (cmd?.command === "disconnect") {
      desired = false; qrAt = 0;
      const s = sock; sock = undefined; connected = false;
      if (s) { try { await s.logout(); } catch { /* already gone */ } s.end(new Error("Disconnected by request.")); }
      await events;
      await q("delete from auth_state where session_id=$1", [SESSION]);
      await q("update sessions set desired=false, phone=null where id=$1 and worker_id=$2", [SESSION, WORKER]);
      await setState("disconnected");
    }
    if (cmd?.command === "connect") { desired = true; nextTry = 0; }
    // A QR code that nobody scanned for a while: close and generate a fresh one.
    if (desired && sock && !connected && qrAt && Date.now() - qrAt > 60_000) {
      const old = sock; sock = undefined; qrAt = 0; old.end(new Error("QR code expired.")); nextTry = Date.now() + 1000;
      await setState("reconnecting");
    }
    if (desired && !sock && Date.now() >= nextTry) await connect();
    await sendNext().catch((e) => console.error("worker: send queue failed:", e instanceof Error ? e.message : e));
    await applyChange().catch((e) => console.error("worker: edit/delete failed:", e instanceof Error ? e.message : e));
  } catch (e) {
    console.error("worker: database unavailable or lease lost:", e instanceof Error ? e.message : e);
    if (Date.now() - lastLease > 30_000) return void shutdown();
  }
  if (!stopping) setTimeout(tick, 1000);
}

async function shutdown() {
  if (stopping) return;
  stopping = true; connected = false;
  sock?.end(new Error("Worker stopped."));
  await events;
  await q("update sessions set lease_until=now() where id=$1 and worker_id=$2", [SESSION, WORKER]).catch(() => {});
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await takeLease();
// A message left "sending" by a previous run may or may not have gone out.
await q(`update messages m set status='uncertain', error='The worker restarted while sending. Check before sending again.'
  from conversations c where c.id=m.conversation_id and c.session_id=$1 and m.status='sending'`, [SESSION]);
await q(`update messages m set change_status='failed', change_error='The worker restarted during the request. Check on the phone.'
  from conversations c where c.id=m.conversation_id and c.session_id=$1 and m.change_status='running'`, [SESSION]);
desired = !!(await q1("select 1 from auth_state where session_id=$1 and key='creds'", [SESSION])) || !!(await q1("select 1 from sessions where id=$1 and desired", [SESSION]));
await setState(desired ? "reconnecting" : "disconnected");
console.log(`worker: session ${SESSION} ready${desired ? "" : ". Ask the API to connect it, then scan the QR code."}`);
void tick();
