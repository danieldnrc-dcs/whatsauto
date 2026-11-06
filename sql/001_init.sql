-- WhatsApp Central Base: initial schema.
-- One row per WhatsApp number ("session"). Each number is served by its own worker process.
create table sessions (
  id           integer generated always as identity primary key,
  name         text not null default '',
  phone        text,                                   -- number of the connected account (digits only)
  state        text not null default 'disconnected'
               check (state in ('disconnected','connecting','qr','connected','reconnecting')),
  desired      boolean not null default false,         -- the worker keeps trying to be connected while true
  command      text check (command in ('connect','disconnect')),
  qr           text,                                   -- encrypted QR payload, short lived
  qr_expires_at timestamptz,
  worker_id    uuid,
  lease_until  timestamptz,                            -- only one live worker per session
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- Baileys credentials and signal keys, encrypted with SECRET.
create table auth_state (
  session_id integer not null references sessions(id) on delete cascade,
  key        text not null,
  value      text not null,
  primary key (session_id, key)
);

create table conversations (
  id              uuid primary key default gen_random_uuid(),
  session_id      integer not null references sessions(id) on delete cascade,
  jid             text not null,                       -- WhatsApp identifier (number@s.whatsapp.net or @lid)
  phone           text,                                -- digits only, when known
  name            text not null default '',
  jid_verified    boolean not null default false,      -- true once WhatsApp confirmed the number exists
  external_ref    text,                                -- free field for your own system (customer id, ticket...)
  metadata        jsonb not null default '{}'::jsonb,  -- free field for your own system
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (session_id, jid)
);
create index conversations_recent on conversations (session_id, last_message_at desc nulls last, id);
create index conversations_external_ref on conversations (external_ref) where external_ref is not null;

create table media (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  mime        text not null,
  size        integer not null check (size > 0),
  storage_key text not null unique,
  created_at  timestamptz not null default now()
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  external_id     text,                                -- WhatsApp message id
  direction       text not null check (direction in ('in','out','out_phone')), -- out_phone: sent from the phone itself
  body            text not null default '',
  media_id        uuid references media(id),
  status          text not null check (status in ('received','queued','sending','sent','delivered','read','failed','uncertain')),
  idempotency_key text unique,                         -- sending twice with the same key never sends twice
  error           text,
  author_name     text,                                -- free label for who sent it on your side
  sent_at         timestamptz not null default now(),  -- message time (WhatsApp time for inbound messages)
  updated_at      timestamptz not null default now(),
  edited_at       timestamptz,
  original_body   text,
  deleted_at      timestamptz,
  -- Pending edit/delete request on an outbound message, executed by the worker.
  change_type     text check (change_type in ('edit','delete')),
  change_body     text,
  change_status   text check (change_status in ('queued','running','failed')),
  change_error    text,
  change_at       timestamptz,
  unique (conversation_id, external_id),
  check (direction <> 'out' or idempotency_key is not null)
);
create index messages_history on messages (conversation_id, sent_at desc, id);
create index messages_queue on messages (sent_at) where status = 'queued';
create index messages_changes on messages (change_at) where change_status in ('queued','running');

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  hash         text not null unique,                   -- sha-256 of the key; the key itself is shown once
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create table webhooks (
  id         uuid primary key default gen_random_uuid(),
  url        text not null,
  secret     text not null,                            -- signs each delivery (HMAC-SHA256)
  events     text[] not null default '{}',             -- empty = all events
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table webhook_deliveries (
  id              bigint generated always as identity primary key,
  webhook_id      uuid not null references webhooks(id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now()
);
create index webhook_deliveries_pending on webhook_deliveries (next_attempt_at) where status = 'pending';

-- Optional: a first session so the demo panel has something to connect.
insert into sessions (name) values ('Main number');
