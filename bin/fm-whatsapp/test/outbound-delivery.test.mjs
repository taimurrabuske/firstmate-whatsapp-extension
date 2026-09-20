// Outbound delivery journal contract: send acknowledgement, crash windows,
// restart recovery, retry identity, duplicate suppression, expiry, and route
// binding for the WhatsApp and Telegram outbound paths.
// Faults are injected deterministically: the send callback models transport
// outcomes (rejected, accepted-but-unconfirmed), and crash windows are
// reproduced by restoring the exact durable files a crash at that instant
// would leave behind, then running a fresh bridge against them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, Store, ownIdentity, readJson, writeJson, sha256, MAX_SEEN } from '../core.mjs';
import { TelegramDelegate, telegramConfig } from '../telegram.mjs';

const user = { id: '15555550123:7@s.whatsapp.net', lid: '12345:2@lid' };
const identity = ownIdentity(user);

function whatsappFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-outbound-wa-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'delegate-state');
  const store = new Store(home, state);
  let now = 1000;
  let sendOutcome = 'ok'; // 'ok' | 'reject' | 'unconfirmed'
  const snapshot = { schema: 'fm-whatsapp-events.v1', afk: true, session: 'away-1', events: [] };
  const calls = { sent: [] };
  const send = async (jid, text, id) => {
    if (sendOutcome === 'reject') return false;
    calls.sent.push({ jid, text, id });
    if (sendOutcome === 'unconfirmed') return false; // accepted remotely, never acknowledged
    return true;
  };
  const makeBridge = () => new Bridge({ store, clock: () => now, events: async () => snapshot,
    inbox: async () => {}, status: async () => 'status', send });
  const bridge = makeBridge();
  bridge.connect(user);
  return {
    home, state, store, bridge, calls, snapshot,
    restart: () => { const next = makeBridge(); next.connect(user); return next; },
    advance: (seconds = 5) => { now += seconds; },
    now: () => now,
    failSend: value => { sendOutcome = value; }
  };
}

// Restore the exact durable state a WhatsApp crash at a given instant leaves
// behind: the queue entry was not removed yet, and the receipt may or may not
// exist depending on the precise crash point.
async function crashBeforeRemoval(f) {
  const name = f.store.records('outbox')[0];
  const job = readJson(f.store.file(`outbox/${name}`));
  f.advance();
  await f.bridge.flush();
  writeJson(f.store.file(`outbox/${name}`), job); // queue entry was not removed yet
  return name;
}
async function crashAfterAcceptBeforeReceipt(f) {
  const name = await crashBeforeRemoval(f);
  fs.unlinkSync(f.store.file(`sent/${name}`)); // local receipt was never written
  return name;
}

test('crash between receipt write and queue removal recovers on restart without a second send', async t => {
  const f = whatsappFixture(t);
  f.store.enqueue('The change is verified.', { kind: 'reply', session: '', id: 'R1' });
  const name = await crashBeforeRemoval(f);
  assert.ok(readJson(f.store.file(`sent/${name}`)), 'receipt survives the crash');
  const restarted = f.restart();
  await restarted.flush();
  assert.equal(f.calls.sent.length, 1);
  assert.equal(f.store.records('outbox').length, 0);
  assert.ok(readJson(f.store.file(`sent/${name}`)));
});

test('crash after remote acceptance without a local receipt duplicates with the same retry identity', async t => {
  const f = whatsappFixture(t);
  f.store.enqueue('The change is verified.', { kind: 'reply', session: '', id: 'R2' });
  const name = await crashAfterAcceptBeforeReceipt(f);
  const first = f.calls.sent[0];
  const restarted = f.restart();
  await restarted.flush();
  // Honest at-least-once: the phone received the text twice, and the retry kept
  // the pre-generated remote identity so a receiver can at least see it is the
  // same queued message. Delivery is never exactly-once.
  assert.equal(f.calls.sent.length, 2);
  assert.equal(f.calls.sent[1].id, first.id);
  assert.equal(f.store.records('outbox').length, 0);
  const receipt = readJson(f.store.file(`sent/${name}`));
  assert.deepEqual(receipt.deliveredRoute, { account: identity.account, recipient: identity.account });
  assert.equal(receipt.delivered, f.now());
});

test('accepted send that is never acknowledged keeps its identity and retries without a receipt', async t => {
  const f = whatsappFixture(t);
  f.store.enqueue('Need a decision on the rollout.', { session: 'away-1', id: 'EV1' });
  f.failSend('unconfirmed');
  await f.bridge.flush();
  assert.equal(f.calls.sent.length, 1); // the server accepted; the bridge cannot know
  assert.equal(f.store.records('outbox').length, 1);
  const job = readJson(f.store.file(`outbox/${f.store.records('outbox')[0]}`));
  assert.equal(job.attempts, 1);
  assert.equal(job.next, f.now() + 2);
  assert.equal(f.store.records('sent').length, 0);
  assert.match(readJson(f.store.file('health.json')).problem, /delivery failed or uncertain/);
  await f.bridge.flush(); // backoff holds before the retry time
  assert.equal(f.calls.sent.length, 1);
  f.failSend('ok'); f.advance();
  await f.bridge.flush();
  assert.equal(f.calls.sent.length, 2);
  assert.equal(f.calls.sent[1].id, f.calls.sent[0].id); // identical retry identity
  assert.equal(f.store.records('outbox').length, 0);
  assert.equal(f.store.records('sent').length, 1);
});

test('rejected send is retried after backoff without ever writing a receipt', async t => {
  const f = whatsappFixture(t);
  f.store.enqueue('Still away?', { session: 'away-1', id: 'EV2' });
  f.failSend('reject');
  await f.bridge.flush();
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.store.records('sent').length, 0);
  assert.equal(f.store.records('outbox').length, 1);
  f.failSend('ok'); f.advance();
  await f.bridge.flush();
  assert.equal(f.calls.sent.length, 1);
  assert.equal(f.store.records('outbox').length, 0);
});

test('delivery receipts expire on the same day boundary as inbound receipts; suppression ends with them', async t => {
  const f = whatsappFixture(t);
  f.store.enqueue('Need a decision on the rollout.', { session: 'away-1', id: 'EV3' });
  await f.bridge.flush();
  const name = f.store.records('sent')[0];
  // Within the window the sent journal suppresses duplicate enqueues.
  const key = f.store.enqueue('Need a decision on the rollout.', { session: 'away-1', id: 'EV3' });
  assert.equal(f.store.records('outbox').length, 0);
  f.advance(86401);
  await f.bridge.refresh(); // heartbeat prunes aged delivery receipts
  assert.equal(f.store.records('sent').length, 0);
  assert.equal(readJson(f.store.file(`sent/${name}`)), null);
  // After expiry the same identity can queue again: suppression was only
  // provable while the receipt existed. This is the documented at-least-once
  // boundary, not a crash window.
  assert.equal(f.store.enqueue('Need a decision on the rollout.', { session: 'away-1', id: 'EV3' }), key);
  assert.equal(f.store.records('outbox').length, 1);
});

test('pruneSent keeps records without a confident delivery time and never touches other windows', t => {
  const f = whatsappFixture(t);
  const aged = `${sha256('aged')}.json`, fresh = `${sha256('fresh')}.json`, opaque = `${sha256('opaque')}.json`;
  const write = (name, value) => fs.writeFileSync(f.store.file(`sent/${name}`), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  write(aged, { key: 'aged', delivered: f.now() - 86401 });
  write(fresh, { key: 'fresh', delivered: f.now() });
  write(opaque, { key: 'opaque' }); // no provable time: retained for inspection
  f.store.pruneSent(f.now());
  assert.equal(f.store.records('sent').sort().join(','), [fresh, opaque].sort().join(','));
});

test('aged receipts cannot dead-end delivery at the journal limit', async t => {
  const f = whatsappFixture(t);
  // Fill the sent journal to its refusal bound with receipts that are already
  // past the retention window (plain writes keep the arrange step fast; the
  // bridge reads them with the ordinary reader).
  for (let i = 0; i < MAX_SEEN; i++) {
    fs.writeFileSync(f.store.file(`sent/${sha256(`stale-${i}`)}.json`),
      `${JSON.stringify({ key: `stale-${i}`, delivered: f.now() - 90000 })}\n`, { mode: 0o600 });
  }
  f.store.enqueue('One more alert.', { session: 'away-1', id: 'EV4' });
  await f.bridge.flush();
  assert.equal(f.calls.sent.length, 0); // refusal without pruning
  assert.match(readJson(f.store.file('health.json')).problem, /receipt limit/);
  assert.equal(f.store.records('outbox').length, 1);
  f.advance(86401);
  await f.bridge.refresh(); // expiry makes the bound self-healing
  assert.equal(f.store.records('sent').length, 0);
  await f.bridge.flush();
  assert.equal(f.calls.sent.length, 1);
  assert.equal(f.store.records('outbox').length, 0);
});

test('only proactive alerts expire with their session; replies and queued work are retained', async t => {
  const f = whatsappFixture(t);
  f.store.enqueue('Need a decision on the rollout.', { session: 'away-1', id: 'EV5' });
  f.store.enqueue('The change is verified.', { kind: 'reply', session: '', id: 'R3' });
  f.snapshot.session = 'away-2';
  await f.bridge.refresh();
  const kinds = f.store.records('outbox').map(name => readJson(f.store.file(`outbox/${name}`)).kind).sort();
  assert.deepEqual(kinds, ['reply']); // the alert expired, the reply did not
  assert.equal(readJson(f.store.file('expired.json')).length, 1);
});

test('quoted-reply context is provable while the receipt is retained and degrades safely after expiry', async t => {
  const f = whatsappFixture(t);
  f.store.enqueue('Pick the flag name.', { session: 'away-1', id: 'EV6' });
  await f.bridge.flush();
  const sentId = f.calls.sent[0].id;
  const inbound = id => ({ key: { id, remoteJid: identity.account, fromMe: true },
    messageTimestamp: f.now() + 1,
    message: { extendedTextMessage: { text: 'Choose A', contextInfo: { stanzaId: sentId, participant: user.id } } } });
  await f.bridge.stage({ type: 'notify', messages: [inbound('ANSWER1')] });
  const pending = readJson(f.store.file(`pending/${sha256(`${identity.account}\nANSWER1`)}.json`));
  assert.match(pending.body, /Persisted quoted Firstmate message/);
  fs.unlinkSync(f.store.file(`pending/${sha256(`${identity.account}\nANSWER1`)}.json`));
  f.advance(86401);
  await f.bridge.refresh();
  await f.bridge.stage({ type: 'notify', messages: [inbound('ANSWER2')] });
  const degraded = readJson(f.store.file(`pending/${sha256(`${identity.account}\nANSWER2`)}.json`));
  assert.ok(degraded, 'the answer is still accepted after receipt expiry');
  assert.ok(!degraded.body.includes('Persisted quoted Firstmate message'));
});

function telegramFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-outbound-tg-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = new Store(base, path.join(base, 'private'));
  writeJson(store.file('identity.json'), { account: '15555550123@s.whatsapp.net' });
  const tokenFile = path.join(base, 'token');
  fs.writeFileSync(tokenFile, `123456:${'a'.repeat(30)}`, { mode: 0o600 });
  writeJson(store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30, whatsappRoute: store.currentRoute() });
  const config = telegramConfig(store);
  let now = 1000, nextId = 20, failSend = false;
  let reader = () => ({ data: Buffer.from('report'), mime: 'text/plain', name: 'report.txt' });
  const sends = [];
  const makeDelegate = () => new TelegramDelegate({ store, adapter: {}, clock: () => now,
    attachmentReader: job => reader(job),
    clientFactory: () => ({ updates: async () => [], send: async (text, attachment) => {
      if (failSend) throw new Error('send refused');
      sends.push({ text, attachment: attachment?.name ?? null });
      return `TG_${nextId++}`;
    } }) });
  const delegate = makeDelegate();
  return {
    base, store, sends, delegate, route: config.route,
    restart: () => makeDelegate(),
    advance: (seconds = 5) => { now += seconds; },
    now: () => now,
    failSend: value => { failSend = value; },
    setReader: value => { reader = value; }
  };
}

// Telegram crash windows reproduce the same durable instants via the fallback
// delivery tick, which needs the outage window to have elapsed.
async function telegramCrashBeforeRemoval(f) {
  const name = f.store.records('outbox')[0];
  const job = readJson(f.store.file(`outbox/${name}`));
  f.advance(60);
  await f.delegate.tick({ connected: false }, { afk: false, session: '' });
  writeJson(f.store.file(`outbox/${name}`), job); // queue entry was not removed yet
  return name;
}
async function telegramCrashAfterAccept(f) {
  const name = await telegramCrashBeforeRemoval(f);
  fs.unlinkSync(f.store.file(`sent/${name}`)); // local receipt was never written
  return name;
}

test('telegram crash between receipt write and queue removal recovers without a second send', async t => {
  const f = telegramFixture(t);
  f.store.enqueue('The report is attached.', { kind: 'reply', session: '', route: f.route, attachment: { name: 'report.txt' } });
  const name = await telegramCrashBeforeRemoval(f);
  assert.equal(f.sends.length, 1);
  await f.delegate.tick({ connected: false }, { afk: false, session: '' });
  assert.equal(f.sends.length, 1); // the written receipt suppresses the resend
  assert.equal(f.store.records('outbox').length, 0);
  assert.equal(readJson(f.store.file(`sent/${name}`)).remoteId, 'TG_20');
});

test('telegram crash after server acceptance without a local receipt duplicates (at-least-once)', async t => {
  const f = telegramFixture(t);
  f.store.enqueue('The report is attached.', { kind: 'reply', session: '', route: f.route, attachment: { name: 'report.txt' } });
  await telegramCrashAfterAccept(f);
  assert.equal(f.sends.length, 1);
  await f.delegate.tick({ connected: false }, { afk: false, session: '' });
  // Telegram assigns server-side ids; the client cannot dedupe, so the crash
  // window duplicates exactly as documented. The message is never lost.
  assert.equal(f.sends.length, 2);
  assert.equal(f.store.records('outbox').length, 0);
});

test('telegram send failure persists backoff and identity; restart honours the retry time', async t => {
  const f = telegramFixture(t);
  f.store.enqueue('The report is attached.', { kind: 'reply', session: '', route: f.route, attachment: { name: 'report.txt' } });
  f.failSend(true);
  await f.delegate.tick({ connected: false }, { afk: false, session: '' });
  assert.equal(f.sends.length, 0);
  const name = f.store.records('outbox')[0];
  const job = readJson(f.store.file(`outbox/${name}`));
  assert.equal(job.attempts, 1);
  assert.ok(job.next > f.now());
  await f.delegate.tick({ connected: false }, { afk: false, session: '' }); // before `next`
  assert.equal(f.sends.length, 0);
  f.advance(300); f.failSend(false);
  await f.restart().tick({ connected: false }, { afk: false, session: '' });
  assert.equal(f.sends.length, 1);
  assert.equal(f.store.records('outbox').length, 0);
  assert.equal(readJson(f.store.file(`sent/${name}`)).remoteId, 'TG_20');
});

test('unavailable telegram attachment backs off persistently instead of stalling the tick', async t => {
  const f = telegramFixture(t);
  let reads = 0;
  f.store.enqueue('The report is attached.', { kind: 'reply', session: '', route: f.route, attachment: { name: 'report.txt' } });
  f.setReader(() => { reads += 1; return null; });
  await f.delegate.tick({ connected: false }, { afk: false, session: '' });
  assert.equal(f.sends.length, 0);
  const job = readJson(f.store.file(`outbox/${f.store.records('outbox')[0]}`));
  assert.equal(job.attempts, 1); // recorded like any failed send
  assert.ok(job.next > f.now());
  assert.equal(readJson(f.store.file('telegram-health.json')).problem, '');
  await f.delegate.tick({ connected: false }, { afk: false, session: '' });
  assert.equal(reads, 1); // backoff prevents a hot retry loop
  f.advance(300);
  f.setReader(() => ({ data: Buffer.from('report'), mime: 'text/plain', name: 'report.txt' }));
  await f.delegate.tick({ connected: false }, { afk: false, session: '' });
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].attachment, 'report.txt');
  assert.equal(f.store.records('outbox').length, 0);
});

test('telegram keeps foreign-route jobs unsent across a restart while bound work flows', async t => {
  const f = telegramFixture(t);
  f.store.enqueue('bound reply', { kind: 'reply', session: '', route: f.store.currentRoute(),
    fallbackRoute: f.route });
  f.store.enqueue('foreign reply', { kind: 'reply', session: '', route: f.store.currentRoute(),
    fallbackRoute: { transport: 'telegram', account: 'telegram:999999', recipient: 'telegram:1234' } });
  await f.delegate.tick({ connected: true }, { afk: false, session: '' }); // outage clock starts from the last connected observation
  assert.equal(f.sends.length, 0); // WhatsApp is connected; the fallback is not used
  f.advance(60);
  await f.delegate.tick({ connected: false }, { afk: false, session: '' });
  assert.equal(f.sends.length, 1);
  f.advance(60);
  await f.restart().tick({ connected: false }, { afk: false, session: '' });
  assert.equal(f.sends.length, 1); // the foreign fallback is never adopted
  assert.equal(f.store.records('outbox').length, 1);
  assert.match(readJson(f.store.file('outbox/' + f.store.records('outbox')[0])).text, /foreign/);
});
