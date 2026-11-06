// Outbound events. Anything that happens (message received, status changed...) is queued here and
// delivered to every active webhook by the dispatcher in the api process.
import { q } from "./db.ts";

export type EventName =
  | "message.received" | "message.sent" | "message.status" | "message.failed"
  | "message.edited" | "message.deleted" | "session.state";

export async function emit(event: EventName, payload: Record<string, unknown>) {
  await q(
    `insert into webhook_deliveries (webhook_id, event, payload)
     select id, $1, $2::jsonb from webhooks where active and (events = '{}' or $1 = any(events))`,
    [event, JSON.stringify({ event, at: new Date().toISOString(), data: payload })],
  );
}
