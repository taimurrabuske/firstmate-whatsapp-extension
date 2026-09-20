// Focused regression coverage for private durable-state integrity: malformed,
// truncated, stale, and incompatible records are quarantined byte-preserved
// instead of wedging scans or being treated as empty, and bounded retention
// deletes only proven terminal artifacts while unresolved work always survives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge, Store, readJson, writeJson, sha256 } from '../core.mjs';
import { FirstmateAdapter } from '../firstmate.mjs';
import { RequestJournal } from '../requests.mjs';
import { NotificationPolicy } from '../notifications.mjs';
import { QUARANTINE_INSPECTION_LIMIT, RETENTION, quarantineSummary, retainPrivateState } from '../retention.mjs';
import { doctorReport } from '../cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const route = { account: '15555550123@s.whatsapp.net', recipient: '15555550123@s.whatsapp.net' };
const identity = { account: route.account, aliases: [route.account] };

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-retention-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = new Store(base, path.join(base, 'private'));
  let now = 5000;
  const bridge = new Bridge({ store, clock: () => now,
    events: async () => ({ schema: 'fm-whatsapp-events.v1', afk: false, session: '', events: [] }),
    inbox: async () => {}, status: async () => '', send: async () => true });
  bridge.connect({ id: '15555550123:7@s.whatsapp.net', lid: '12345:2@lid' });
  return { base, store, bridge, requests: bridge.requests, clock: () => now, advance: seconds => { now += seconds; } };
}
const corrupt = (file, text = '{"truncated') => fs.writeFileSync(file, text, { mode: 0o600 });
const quarantineEntries = (store, bucket) => {
  const directory = path.join(store.root, 'quarantine', bucket);
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => !name.endsWith('.meta.json')) : [];
};

function message(f, id, text) {
  return { key: { id, remoteJid: identity.account, fromMe: true }, messageTimestamp: f.clock(),
    message: { conversation: text } };
}

test('a malformed queue record is quarantined byte-preserved and its sibling still delivers', async t => {
  const f = fixture(t);
  const poisoned = f.store.enqueue('poisoned sibling', { kind: 'reply', session: '', id: 'poison' });
  const healthy = f.store.enqueue('healthy sibling', { kind: 'reply', session: '', id: 'healthy' });
  corrupt(f.store.file(`outbox/${poisoned}.json`));
  const sent = [];
  f.bridge.send = async (jid, text) => { sent.push(text); return true; };
  f.advance(5);
  await f.bridge.flush();
  assert.deepEqual(sent, ['[Firstmate] healthy sibling']);
  assert.deepEqual(f.store.records('outbox'), []);
  const names = quarantineEntries(f.store, 'outbox');
  assert.equal(names.length, 1);
  const preserved = fs.readFileSync(path.join(f.store.root, 'quarantine/outbox', names[0]), 'utf8');
  assert.equal(preserved, '{"truncated');
  const meta = readJson(path.join(f.store.root, 'quarantine/outbox', `${names[0]}.meta.json`));
  assert.equal(meta.schema, 'fm-whatsapp-quarantine.v1');
  assert.equal(meta.origin, `outbox/${poisoned}.json`);
  assert.match(meta.reason, /malformed or truncated/);
  assert.equal(fs.statSync(path.join(f.store.root, 'quarantine/outbox', names[0])).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.store.root, 'quarantine')).mode & 0o777, 0o700);
  // Once quarantined, redelivery of the same logical message deduplicates on key.
  assert.equal(f.store.enqueue('poisoned sibling', { kind: 'reply', session: '', id: 'poison' }), poisoned);
  assert.deepEqual(quarantineEntries(f.store, 'outbox'), names);
});

test('a symlinked queue record is quarantined without following or touching its target', async t => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside.json');
  fs.writeFileSync(outside, '{"kind":"reply"}\n', { mode: 0o600 });
  const key = sha256('reply\n\nlink');
  fs.symlinkSync(outside, f.store.file(`outbox/${key}.json`));
  f.advance(5);
  f.bridge.send = async () => true;
  await f.bridge.flush();
  assert.equal(fs.existsSync(outside), true);
  assert.equal(fs.existsSync(f.store.file(`outbox/${key}.json`)), false);
  assert.equal(quarantineEntries(f.store, 'outbox').length, 1);
});

test('an incompatible request journal schema is quarantined while open work stays listed', t => {
  const f = fixture(t);
  f.requests.receive(sha256('own-account\nfuture'), { route, text: 'future schema record', provenance: 'whatsapp' });
  const futureFile = f.store.file(`requests/${sha256('own-account\nfuture')}.json`);
  writeJson(futureFile, { ...readJson(futureFile), schema: 'fm-remote-request.v2', state: 'working' });
  f.requests.receive(sha256('own-account\nopen'), { route, text: 'still open', provenance: 'whatsapp' });
  const rows = f.requests.list(route);
  assert.deepEqual(rows.map(row => row.key), [sha256('own-account\nopen')]);
  assert.equal(quarantineEntries(f.store, 'requests').length, 1);
  // The quarantined record is refused, not silently resurrected as empty state.
  assert.equal(f.requests.get(sha256('own-account\nfuture')), null);
  assert.throws(() => f.requests.transition(sha256('own-account\nfuture'), 'waiting'), /unknown request identity/);
  // Re-receiving the same message re-journals it cleanly under the same key.
  f.requests.receive(sha256('own-account\nfuture'), { route, text: 'future schema record', provenance: 'whatsapp' });
  assert.equal(f.requests.get(sha256('own-account\nfuture')).state, 'received');
});

test('a truncated pending job is quarantined and its sibling request still reaches Firstmate', async t => {
  const f = fixture(t);
  const inbox = [];
  f.bridge.inbox = async (key, text) => { inbox.push(key); };
  f.bridge.stage({ type: 'notify', messages: [message(f, 'POISONMSG', 'poisoned request'), message(f, 'HEALTHY1', 'healthy request')] });
  assert.equal(f.store.records('pending').length, 2);
  // Key derivation is deterministic: sha256(account\nmessage-id).
  const poisonedKey = sha256(`${f.bridge.identity.account}\nPOISONMSG`);
  corrupt(f.store.file(`pending/${poisonedKey}.json`));
  const before = quarantineEntries(f.store, 'pending').length;
  await f.bridge.processPending();
  assert.deepEqual(inbox.length, 1);
  assert.equal(f.store.records('pending').length, 0);
  assert.equal(quarantineEntries(f.store, 'pending').length, before + 1);
});

test('send-receipt expiry stays owned by Store.pruneSent, not the retention sweep', t => {
  const f = fixture(t);
  const now = 10 * RETENTION.seconds;
  writeJson(f.store.file(`sent/${sha256('old')}.json`),
    { key: sha256('old'), kind: 'reply', session: '', text: 'delivered', created: now - 86401, delivered: now - 86401 });
  // The sweep leaves the sent journal entirely to pruneSent.
  const report = retainPrivateState(f.store, null, { now });
  assert.equal('sent' in report, false);
  assert.equal(fs.existsSync(f.store.file(`sent/${sha256('old')}.json`)), true);
  f.store.pruneSent(now);
  assert.equal(fs.existsSync(f.store.file(`sent/${sha256('old')}.json`)), false);
});

test('retention removes only handled handoffs of terminal requests and terminal journal records', t => {
  const f = fixture(t);
  const options = { home: path.join(f.base, 'home'), codeRoot: path.join(f.base, 'code'),
    state: path.join(f.base, 'home', 'state'), store: f.store, extensionRoot: root, run: async () => 'queued x\n' };
  fs.mkdirSync(options.home, { recursive: true });
  const adapter = new FirstmateAdapter(options);
  const now = 10 * RETENTION.seconds;
  const horizonAgo = now - RETENTION.seconds - 10;
  const terminal = sha256('own-account\nterminal'), open = sha256('own-account\nopen'),
    unhandled = sha256('own-account\nunhandled');
  const publish = (key, phase, created) => writeJson(f.store.file(`handoffs/${key}.json`),
    { id: `note-${key.slice(0, 6)}`, body: adapter.envelope(key, 'request text'), phase, route, created,
      binding: { home: options.home, codeRoot: options.codeRoot, state: options.state }, maintenance: { rings: 0, last: 0 } });
  const journal = (key, state) => {
    f.requests.receive(key, { route, text: 'request text' });
    if (state !== 'received') f.requests.transition(key, state, 'progress recorded');
  };
  journal(terminal, 'completed'); publish(terminal, 'handled', horizonAgo);
  journal(open, 'working'); publish(open, 'handled', horizonAgo);
  journal(unhandled, 'completed'); publish(unhandled, 'saved', horizonAgo);
  writeJson(f.store.file(`handoffs/${sha256('own-account\nuncertain')}.json`),
    { id: 'note-x', body: 'envelope', phase: 'uncertain', route, created: horizonAgo });

  const report = retainPrivateState(f.store, f.requests, { now });
  assert.equal(report.handoffs, 1);
  assert.equal(report.requests, 1);
  assert.equal(fs.existsSync(f.store.file(`handoffs/${terminal}.json`)), false);
  assert.equal(fs.existsSync(f.store.file(`requests/${terminal}.json`)), false);
  // Open work and unresolved publication evidence always survive.
  assert.equal(fs.existsSync(f.store.file(`requests/${open}.json`)), true);
  assert.equal(fs.existsSync(f.store.file(`handoffs/${open}.json`)), true);
  assert.equal(fs.existsSync(f.store.file(`handoffs/${unhandled}.json`)), true);
  assert.equal(fs.existsSync(f.store.file(`requests/${unhandled}.json`)), true);
  assert.equal(fs.existsSync(f.store.file(`handoffs/${sha256('own-account\nuncertain')}.json`)), true);
  // Recent handled-terminal artifacts stay inside the horizon: recency for a
  // journal record is its terminal transition time, not the receipt's creation.
  const recent = sha256('own-account\nrecent');
  journal(recent, 'failed');
  publish(recent, 'handled', now - 60);
  writeJson(f.store.file(`requests/${recent}.json`), { ...readJson(f.store.file(`requests/${recent}.json`)), updated: now - 60 });
  assert.deepEqual(retainPrivateState(f.store, f.requests, { now }), { ...report, requests: 0, handoffs: 0 });
  assert.equal(fs.existsSync(f.store.file(`requests/${recent}.json`)), true);
});

test('attachment retention keeps undelivered and referenced content and removes only aged orphans', t => {
  const f = fixture(t);
  const now = 10 * RETENTION.seconds;
  const blob = (bucket, digest, age, body) => {
    const file = f.store.file(`${bucket}/${digest}`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, 'attachment-bytes', { mode: 0o600 });
    fs.utimesSync(file, new Date((now - age) * 1000), new Date((now - age) * 1000));
    fs.writeFileSync(`${file}.json`, JSON.stringify({ schema: 'fm-whatsapp-attachment.v1', digest }) + '\n', { mode: 0o600 });
    if (body) fs.writeFileSync(`${file}.transcript.txt`, 'transcript', { mode: 0o600 });
    return file;
  };
  const orphan = blob('attachments/incoming', sha256('orphan'), RETENTION.seconds + 10);
  const quoted = blob('attachments/outgoing', sha256('quoted'), RETENTION.seconds + 10);
  const cited = blob('attachments/incoming', sha256('cited'), RETENTION.seconds + 10, true);
  const fresh = blob('attachments/incoming', sha256('fresh'), 60);
  const transcribed = blob('attachments/incoming', sha256('transcribed'), RETENTION.seconds + 10, true);
  // The transcript's sibling blob is gone; the cited transcript alone must survive.
  fs.rmSync(transcribed, { force: true });
  writeJson(f.store.file(`outbox/${sha256('attachment-job')}.json`), { key: sha256('attachment-job'), kind: 'reply',
    session: '', text: 'report', attempts: 0, next: 0, created: now, attachment: { digest: sha256('quoted') } });
  fs.mkdirSync(f.store.file('handoffs'), { recursive: true, mode: 0o700 });
  writeJson(f.store.file(`handoffs/${sha256('own-account\ncited')}.json`),
    { id: 'note-cited', body: `Local attachment: ${cited}\nFull private transcript (read completely): ${cited}.transcript.txt`,
      phase: 'saved', route, created: now - RETENTION.seconds - 10 });
  const report = retainPrivateState(f.store, f.requests, { now });
  assert.equal(report.attachments, 1);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(`${orphan}.json`), false);
  // Undelivered queue attachment, body-cited attachment and transcript, and fresh content all stay.
  assert.equal(fs.existsSync(quoted), true);
  assert.equal(fs.existsSync(cited), true);
  assert.equal(fs.existsSync(`${cited}.transcript.txt`), true);
  assert.equal(fs.existsSync(fresh), true);
  // A transcript cited by a record body survives even with its blob already gone.
  assert.equal(fs.existsSync(`${transcribed}.transcript.txt`), true);
});

test('stale atomic-write litter is swept while live records and fresh temporaries stay', t => {
  const f = fixture(t);
  const now = 20_000;
  f.store.enqueue('a real queued message', { kind: 'reply', session: '', id: 'litter-check' });
  const stale = f.store.file('outbox/.staging-leftover.tmp');
  const fresh = f.store.file('outbox/.fresh-staging.tmp');
  for (const file of [stale, fresh]) fs.writeFileSync(file, 'partial', { mode: 0o600 });
  fs.utimesSync(stale, new Date((now - 7200) * 1000), new Date((now - 7200) * 1000));
  const report = retainPrivateState(f.store, null, { now });
  assert.equal(report.temporaries, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(f.store.records('outbox').length, 1);
});

test('a damaged expired-receipt list is quarantined and alert expiry continues', t => {
  const f = fixture(t);
  corrupt(f.store.file('expired.json'));
  f.store.enqueue('stale alert', { kind: 'alert', session: 'away-1', id: 'stale-1', automatic: true });
  f.advance(10);
  f.bridge.snapshot = { afk: false, session: 'away-2', events: [] };
  f.store.expire(f.bridge.snapshot, f.clock());
  assert.equal(f.store.records('outbox').length, 0);
  assert.equal(quarantineEntries(f.store, 'root').length, 1);
  let receipts = readJson(f.store.file('expired.json'));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].reason, 'away session ended or replaced');
  // The valid array round-trips: a second expiring alert appends without quarantining.
  f.store.enqueue('another stale alert', { kind: 'alert', session: 'away-2', id: 'stale-2', automatic: true });
  f.advance(10);
  f.store.expire({ afk: false, session: 'away-3', events: [] }, f.clock());
  receipts = readJson(f.store.file('expired.json'));
  assert.equal(receipts.length, 2);
  assert.equal(quarantineEntries(f.store, 'root').length, 1);
});

test('a damaged notification ledger is quarantined and planning restarts without duplicate deliveries', t => {
  const f = fixture(t);
  const policy = new NotificationPolicy({ stateDir: f.store.root });
  const snapshot = { afk: true, session: 'away-1', events: [
    { id: 'event-1', kind: 'completion', text: 'The check completed.', task: 't', project: 'p' }] };
  // First observation of an AFK session is historical and stays silent.
  assert.deepEqual(policy.plan(snapshot, 5000), []);
  corrupt(f.store.file('notification-ledger.json'));
  // A fresh ledger starts at a fresh observation boundary: the already-seen
  // event stays silent (no duplicate), and planning is functional again.
  assert.deepEqual(policy.plan(snapshot, 5001), []);
  assert.equal(quarantineEntries(f.store, 'root').some(name => name.includes('notification-ledger')), true);
  assert.equal(readJson(f.store.file('notification-ledger.json')).schema, 'fm-whatsapp-notification-ledger.v1');
  const next = { afk: true, session: 'away-1', events: [
    { id: 'event-2', kind: 'failure', text: 'The check failed.', task: 't', project: 'p' }] };
  assert.equal(policy.plan(next, 5002).length, 1);
  // Structural validation of preferences keeps failing closed, without quarantine.
  corrupt(f.store.file('notification-preferences.json'));
  assert.throws(() => policy.plan(snapshot, 5003), /unreadable notification state/);
  assert.equal(quarantineEntries(f.store, 'root').some(name => name.includes('notification-preferences')), false);
});

test('a damaged Telegram cursor is quarantined and polling restarts durably', async t => {
  const f = fixture(t);
  corrupt(f.store.file('telegram-cursor.json'));
  writeJson(f.store.file('identity.json'), { account: route.account, pairedAt: 900 });
  const tokenFile = path.join(f.base, 'token');
  fs.writeFileSync(tokenFile, `123456:${'a'.repeat(30)}`, { mode: 0o600 });
  writeJson(f.store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true, tokenFile,
    userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30, whatsappRoute: f.store.currentRoute() });
  const { TelegramDelegate } = await import('../telegram.mjs');
  let offsets = [];
  const delegate = new TelegramDelegate({ store: f.store, clock: () => 5000,
    clientFactory: () => ({ updates: async offset => { offsets.push(offset);
        return [{ update_id: 41, message: { message_id: 10, date: 4900, chat: { id: 1234, type: 'private' },
          from: { id: 1234, is_bot: false }, text: 'status' } }]; },
      send: async () => { throw new Error('unused'); } }) });
  await delegate.tick(f.bridge, { afk: false, session: '', events: [] });
  assert.equal(offsets[0], 0);
  assert.equal(quarantineEntries(f.store, 'root').some(name => name.includes('telegram-cursor')), true);
  assert.equal(readJson(f.store.file('telegram-cursor.json')).offset, 42);
});

test('doctor surfaces quarantine contents for inspection without failing readiness', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-retention-doctor-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const codeRoot = path.join(base, 'firstmate');
  fs.mkdirSync(path.join(codeRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(codeRoot, 'bin/fm-afk-contract.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const store = new Store(home, path.join(base, 'delegate-state'));
  fs.mkdirSync(path.join(store.root, 'quarantine', 'outbox'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(store.root, 'quarantine/outbox/5000-x.json'), '{"truncated', { mode: 0o600 });
  fs.writeFileSync(path.join(store.root, 'quarantine/outbox/5000-x.json.meta.json'), '{}\n', { mode: 0o600 });
  const summary = quarantineSummary(store.root);
  assert.equal(summary.records, 1);
  assert.equal(summary.bytes, '{"truncated'.length);
  const result = doctorReport({ home, env: { FM_HOME: home, FM_CODE_ROOT: codeRoot, FM_DELEGATE_STATE: path.join(base, 'delegate-state') },
    extensionRoot: root, transportReady: true, jqReady: true, processAlive: () => {} });
  const text = result.lines.join('\n');
  assert.match(text, /quarantine holds 1 preserved record/);
  assert.equal(result.ready, true);
  // Past the inspection limit the same findings escalate to a problem.
  for (let index = 0; index < QUARANTINE_INSPECTION_LIMIT; index++) {
    fs.writeFileSync(path.join(store.root, 'quarantine/outbox', `${5000 + index}-y.json`), '{}\n', { mode: 0o600 });
  }
  const escalated = doctorReport({ home, env: { FM_HOME: home, FM_CODE_ROOT: codeRoot, FM_DELEGATE_STATE: path.join(base, 'delegate-state') },
    extensionRoot: root, transportReady: true, jqReady: true, processAlive: () => {} });
  assert.equal(escalated.ready, false);
  assert.match(escalated.lines.join('\n'), /inspect, repair or discard each one manually/);
});

test('quarantine accounting counts records across buckets and ignores metadata sidecars', async t => {
  const f = fixture(t);
  const poisoned = f.store.enqueue('quarantine accounting', { kind: 'reply', session: '', id: 'accounting' });
  corrupt(f.store.file(`outbox/${poisoned}.json`));
  f.advance(5);
  f.bridge.send = async () => true;
  await f.bridge.flush(); // scanning the outbox quarantines the damaged record
  const key = sha256('own-account\nreceipt');
  corrupt(f.store.file(`incoming/${key}.json`));
  f.store.pruneIncoming(f.clock());
  const summary = quarantineSummary(f.store.root);
  assert.equal(summary.records, 2);
  assert.equal(quarantineEntries(f.store, 'outbox').length, 1);
  assert.equal(quarantineEntries(f.store, 'incoming').length, 1);
});
