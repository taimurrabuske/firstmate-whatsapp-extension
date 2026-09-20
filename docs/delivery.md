# Outbound delivery journal

Every outbound WhatsApp and Telegram message is a durable queue entry under `whatsapp/outbox/<key>.json`, where `key` is `sha256(kind, session, id)`. Enqueue is idempotent: an entry whose key already exists in the outbox, or whose delivery receipt still exists, resolves to the same key without queueing a second send. Each entry is created with a pre-generated remote message identity (`remoteId`) that stays stable across every retry.

## Send acknowledgement

A local send return is not a delivery proof. WhatsApp sends register a server-acknowledgement waiter before `sendMessage` and only treat the matching own-chat server receipt (protocol `ack` or `messages.update` status ≥ 2) as delivery; a failed, missing, or timed-out acknowledgement keeps the queue entry and retries. Telegram sends require the server's own `message_id` for the exact configured chat; anything else is an unconfirmed send.

## Crash windows

Receipts are written **before** the queue entry is removed, and both writes are fsynced. Therefore:

- A crash after the receipt write but before queue removal recovers on restart without a second send: the flush path deletes an outbox entry whose receipt already exists.
- A crash after the server accepted a send but before the local receipt was written can duplicate the message on restart. The retry reuses the same `remoteId` (WhatsApp), so a receiver can identify it as the same queued message; Telegram assigns server-side ids, so the client cannot dedupe at all. Delivery is therefore at-least-once and never exactly-once. This window is reproduced deterministically by `bin/fm-whatsapp/test/outbound-delivery.test.mjs`.

Failed or unconfirmed sends persist `attempts` and an exponential backoff deadline (capped at five minutes) in the queue entry before any retry; restarts honour the persisted deadline and identity.

## Ordering

Delivery follows the durable `seq` stamped under the queue lock at enqueue time (`outboundOrder`), never outbox filename hash order, and is stable across restarts and retries. Multi-part messages share a `part.family`; while an earlier part is waiting on its retry deadline, later parts of the same family are held in both the WhatsApp flush and the Telegram fallback so a retry can never reorder, skip, or duplicate a piece. Unrelated entries are unaffected.

## Duplicate suppression and expiry

Duplicate suppression is provable only while local durable state exists. Delivery receipts are retained for 24 hours on the same boundary as inbound receipts, then pruned by the bridge heartbeat (`Store.pruneSent`). Within that window the journal suppresses duplicate enqueues and supplies quoted-reply context. After expiry the same identity can queue again, and a quoted reply degrades safely to an unquoted followup on the same authenticated route. Records without a confident delivery time, and records that cannot be read, are retained for inspection instead of being assumed old. Expiry never removes unsent queue entries.

Proactive alerts additionally expire when their away session ends or their recorded decision is no longer open; those expiries are journaled in `expired.json` (bounded). Replies and explicit notifications never auto-expire: a queued response whose route no longer matches is retained for inspection and reported through bridge health.

## Route binding

WhatsApp delivers only to the route recorded at enqueue time (authenticated account plus selected recipient); a changed route retains the entry and reports `reply route changed` instead of sending to a new person. Telegram accepts a direct entry only when its recorded transport route still matches the paired bot and chat exactly. A WhatsApp-route entry may fall back to Telegram only when Telegram is explicitly configured, the WhatsApp outage has lasted at least `fallbackAfterSeconds`, the entry was enqueued with that exact fallback route bound, and the paired WhatsApp route is unchanged. Pairing or token rotation therefore cannot redirect old replies to a new recipient.

Deterministic fault-injection tests for every window above live in `bin/fm-whatsapp/test/outbound-delivery.test.mjs`.
