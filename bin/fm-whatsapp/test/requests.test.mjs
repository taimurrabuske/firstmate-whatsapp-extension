// Focused regression coverage for the durable request lifecycle:
// terminal transitions, duplicate and conflicting final replies, explicitly
// bound fallback routes on maintenance responses, route changes, and
// uncertain receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store, sha256, readJson, writeJson } from '../core.mjs';
import { FirstmateAdapter } from '../firstmate.mjs';
import { TERMINAL_REQUEST_STATES } from '../requests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const key = sha256('own-account\nmessage-id');
const route = { account: '15555550123@s.whatsapp.net', recipient: '15555550123@s.whatsapp.net' };
const telegramRoute = digest => ({ transport: 'telegram', account: 'telegram:111', recipient: 'telegram:111', credentialDigest: digest });

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wa-requests-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'firstmate'); fs.mkdirSync(home);
  const store = new Store(home, path.join(base, 'delegate'));
  const options = { home, codeRoot: path.join(base, 'code'), state: path.join(home, 'state'), store, extensionRoot: root };
  return { base, home, store, options };
}

function authenticated(f, used = route) {
  writeJson(f.store.file('identity.json'), { account: used.account, pairedAt: 1 });
}

function saveNote(f, body, id) {
  fs.mkdirSync(path.join(f.home, 'state/inbox'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'state/inbox', `${id}.note`), `id=${id}\nat=2026-01-01\nsource=text\n--\n${body}\n`);
}

function publishRequest(f, adapter, requestKey, { fallbackRoute, phase = 'saved', id = 'note-1' } = {}) {
  const text = `request text ${requestKey.slice(0, 8)}`;
  adapter.requests.receive(requestKey, { route, text });
  const receipt = { id, body: adapter.envelope(requestKey, text), phase, route, created: 1,
    binding: { home: fs.realpathSync(f.home), codeRoot: path.resolve(f.options.codeRoot), state: path.resolve(f.options.state) },
    maintenance: { rings: 0, last: 0 } };
  if (fallbackRoute) receipt.fallbackRoute = fallbackRoute;
  writeJson(f.store.file(`handoffs/${requestKey}.json`), receipt);
  saveNote(f, receipt.body, id);
  return receipt;
}

function queuedJobs(f) {
  return f.store.records('outbox').map(name => readJson(f.store.file(`outbox/${name}`)));
}

test('terminal request records refuse conflicting final results while exact replay stays idempotent', t => {
  const f = fixture(t);
  const journal = new FirstmateAdapter({ ...f.options, run: async () => '' }).requests;
  journal.receive(key, { route, text: 'run the recorded checks' });
  journal.transition(key, 'working', 'checks running');
  journal.transition(key, 'completed', 'All checks passed.');
  const finalRecord = journal.get(key);
  for (const state of ['received', 'picked-up', 'working', 'waiting', 'failed'])
    assert.throws(() => journal.transition(key, state, 'later'), /invalid request transition from completed/);
  assert.deepEqual(journal.get(key), finalRecord);
  // The same terminal state replayed with different text is a conflicting
  // final result: refused without mutating durable history.
  assert.throws(() => journal.transition(key, 'completed', 'All checks failed.'), /recorded result cannot change/);
  assert.deepEqual(journal.get(key), finalRecord);
  // Identical and textless replay return the unchanged record.
  assert.deepEqual(journal.transition(key, 'completed', 'All checks passed.'), finalRecord);
  assert.deepEqual(journal.transition(key, 'completed'), finalRecord);
  assert.ok(TERMINAL_REQUEST_STATES.includes('completed') && TERMINAL_REQUEST_STATES.includes('failed'));
  // Failed records are equally immutable.
  const failedKey = sha256('own-account\nfailed-request');
  journal.receive(failedKey, { route, text: 'run the other checks' });
  journal.transition(failedKey, 'failed', 'Environment unreachable.');
  const failedRecord = journal.get(failedKey);
  assert.throws(() => journal.transition(failedKey, 'completed', 'Recovered anyway.'), /invalid request transition from failed/);
  assert.throws(() => journal.transition(failedKey, 'failed', 'Different failure.'), /recorded result cannot change/);
  assert.deepEqual(journal.get(failedKey), failedRecord);
});

test('non-terminal progress still accepts distinct updates and deduplicates exact repeats', t => {
  const f = fixture(t);
  const journal = new FirstmateAdapter({ ...f.options, run: async () => '' }).requests;
  journal.receive(key, { route, text: 'long request' });
  journal.transition(key, 'working', 'step one');
  const afterFirst = journal.get(key);
  assert.deepEqual(journal.transition(key, 'working', 'step one'), afterFirst);
  assert.equal(afterFirst.history.length, 2);
  journal.transition(key, 'working', 'step two');
  const record = journal.get(key);
  assert.equal(record.state, 'working');
  assert.equal(record.history.length, 3);
  assert.equal(record.history.at(-1).text, 'step two');
});

test('duplicate final replies stay idempotent and conflicting final replies are refused', async t => {
  const f = fixture(t); authenticated(f);
  const fallback = telegramRoute('digest-bound');
  const adapter = new FirstmateAdapter({ ...f.options, run: async () => '' });
  publishRequest(f, adapter, key, { fallbackRoute: fallback });
  adapter.reply(key, 'Result: three checks passed.');
  assert.equal(adapter.requests.get(key).state, 'completed');
  assert.equal(f.store.records('outbox').length, 1);
  adapter.reply(key, 'Result: three checks passed.');
  assert.equal(f.store.records('outbox').length, 1); // Identical replay deduplicates.
  const beforeConflict = readJson(f.store.file(`handoffs/${key}.json`));
  const journalBefore = adapter.requests.get(key);
  assert.throws(() => adapter.reply(key, 'Result: zero checks passed.'), /already completed/);
  assert.equal(f.store.records('outbox').length, 1);
  assert.deepEqual(readJson(f.store.file(`handoffs/${key}.json`)), beforeConflict);
  assert.deepEqual(adapter.requests.get(key), journalBefore);
  const job = queuedJobs(f)[0];
  assert.equal(job.text, 'Result: three checks passed.');
  assert.equal(job.requestKey, key);
  assert.deepEqual(job.fallbackRoute, fallback);
});

test('completed requests refuse every progress state and failed requests refuse completion', async t => {
  const f = fixture(t); authenticated(f);
  const adapter = new FirstmateAdapter({ ...f.options, run: async () => '' });
  publishRequest(f, adapter, key, {});
  adapter.reply(key, 'Done.');
  for (const state of ['picked-up', 'working', 'waiting', 'failed'])
    assert.throws(() => adapter.progress(key, state, 'too late'), /invalid request transition from completed/);
  assert.equal(f.store.records('outbox').length, 1);
  const failedKey = sha256('own-account\nfailed-request');
  publishRequest(f, adapter, failedKey, { id: 'note-2' });
  adapter.progress(failedKey, 'failed', 'Environment unreachable.');
  assert.equal(adapter.requests.get(failedKey).state, 'failed');
  assert.throws(() => adapter.reply(failedKey, 'Recovered.'), /failed request cannot be completed/);
  assert.throws(() => adapter.reply(failedKey, 'Environment unreachable.'), /failed request cannot be completed/);
  assert.equal(queuedJobs(f).length, 2); // Completion reply plus the recorded failure progress only.
});

test('maintenance responses retain only the receipt\'s explicitly bound fallback route', async t => {
  const f = fixture(t); authenticated(f);
  const calls = [];
  const adapter = new FirstmateAdapter({ ...f.options, run: async (file, args) => { calls.push(args.at(-2)); return ''; } });
  const bound = telegramRoute('digest-bound');
  publishRequest(f, adapter, key, { fallbackRoute: bound });
  const unbound = sha256('own-account\nunbound-request');
  publishRequest(f, adapter, unbound, { id: 'note-2' });
  // A currently configured Telegram route must never leak into responses of
  // receipts that were saved without an explicit fallback binding.
  writeJson(f.store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true, userId: '999',
    chatId: '999', enabledAt: 1, fallbackAfterSeconds: 120, tokenFile: '/private/unused-token', whatsappRoute: route });
  const reports = await adapter.maintain({ now: 5000, staleAfter: 10, maxRings: 3 });
  assert.equal(calls.length, 2); // Each stale request re-rang only its own existing inbox note.
  assert.equal(reports.length, 2);
  for (const report of reports) {
    assert.match(report.dedupeId, /^maintenance:[a-f0-9]{64}:/);
    adapter.notifyMaintenance(report);
  }
  const byRequest = Object.fromEntries(queuedJobs(f).map(job => [job.requestKey, job]));
  assert.deepEqual(byRequest[key].fallbackRoute, bound);
  assert.equal(byRequest[unbound].fallbackRoute, undefined);
  assert.equal(byRequest[unbound].route.account, route.account); // Never the configured Telegram route.
  const again = await adapter.maintain({ now: 6000, staleAfter: 10, maxRings: 3 });
  assert.deepEqual(again.map(report => report.dedupeId).sort(), reports.map(report => report.dedupeId).sort());
  for (const report of again) adapter.notifyMaintenance(report);
  assert.equal(f.store.records('outbox').length, 2); // Stable dedupe ids keep repeats idempotent.
});

test('wake-failure and ring-exhausted maintenance keep the bound fallback route', async t => {
  const f = fixture(t); authenticated(f);
  const calls = [];
  const adapter = new FirstmateAdapter({ ...f.options, run: async (file, args) => {
    if (args.at(-2) === 'inbox:note-1') throw new Error('wake pipe broken');
    calls.push(args.at(-2)); return '';
  } });
  const firstBound = telegramRoute('digest-first');
  const secondBound = telegramRoute('digest-second');
  publishRequest(f, adapter, key, { fallbackRoute: firstBound });
  const other = sha256('own-account\nother-request');
  publishRequest(f, adapter, other, { fallbackRoute: secondBound, id: 'note-2' });
  const [wakeFailed] = await adapter.maintain({ now: 5000, staleAfter: 10, maxRings: 1 });
  assert.equal(wakeFailed.key, key);
  assert.equal(wakeFailed.code, 'wake-failed');
  adapter.notifyMaintenance(wakeFailed);
  assert.deepEqual(queuedJobs(f).find(job => job.requestKey === key).fallbackRoute, firstBound);
  const repeat = await adapter.maintain({ now: 6000, staleAfter: 10, maxRings: 1 });
  assert.deepEqual(repeat.map(report => report.key).sort(), [key, other].sort());
  const exhausted = repeat.find(report => report.key === other);
  assert.equal(calls.length, 1); // The ring budget was spent; no further wake is attempted.
  adapter.notifyMaintenance(exhausted);
  assert.deepEqual(queuedJobs(f).find(job => job.requestKey === other).fallbackRoute, secondBound);
  assert.equal(adapter.requests.get(key).state, 'waiting');
  assert.equal(adapter.requests.get(other).state, 'waiting');
});

test('route changes make maintenance silent and refuse responses instead of rebinding', async t => {
  const f = fixture(t); authenticated(f);
  writeJson(f.store.file('recipient.json'), { account: route.recipient });
  const calls = [];
  const adapter = new FirstmateAdapter({ ...f.options, run: async (file, args) => { calls.push(args.at(-2)); return ''; } });
  const bound = telegramRoute('digest-route');
  publishRequest(f, adapter, key, { fallbackRoute: bound });
  writeJson(f.store.file('recipient.json'), { account: '15555550888@s.whatsapp.net' });
  assert.deepEqual(await adapter.maintain({ now: 5000, staleAfter: 10 }), []);
  assert.equal(calls.length, 0);
  assert.throws(() => adapter.reply(key, 'late result'), /current route/);
  assert.throws(() => adapter.progress(key, 'working', 'late'), /current route/);
  assert.throws(() => adapter.notifyMaintenance({ key, dedupeId: `maintenance:${key}:wake-failed`, text: 'Request waiting.' }), /current route/);
  assert.equal(f.store.records('outbox').length, 0);
  // Restoring the bound route resumes the previously bound behavior exactly.
  writeJson(f.store.file('recipient.json'), { account: route.recipient });
  const [report] = await adapter.maintain({ now: 6000, staleAfter: 10 });
  adapter.notifyMaintenance(report);
  assert.deepEqual(queuedJobs(f)[0].fallbackRoute, bound);
});

test('uncertain receipts refuse replies, progress and maintenance notifications without queueing', async t => {
  const f = fixture(t); authenticated(f);
  const adapter = new FirstmateAdapter({ ...f.options, run: async () => '' });
  publishRequest(f, adapter, key, { phase: 'uncertain' });
  assert.throws(() => adapter.reply(key, 'result'), /published authenticated request/);
  assert.throws(() => adapter.progress(key, 'working', 'step'), /published authenticated request/);
  assert.throws(() => adapter.notifyMaintenance({ key, dedupeId: `maintenance:${key}:wake-failed`, text: 'Request waiting.' }),
    /published authenticated request/);
  assert.equal(f.store.records('outbox').length, 0);
  assert.equal(adapter.requests.get(key).state, 'received');
});

test('maintenance never re-rings or revises a completed request', async t => {
  const f = fixture(t); authenticated(f);
  const calls = [];
  const adapter = new FirstmateAdapter({ ...f.options, run: async (file, args) => { calls.push(args.at(-2)); return ''; } });
  publishRequest(f, adapter, key, {});
  adapter.requests.transition(key, 'completed', 'Final recorded result.');
  const reports = await adapter.maintain({ now: 5000, staleAfter: 10 });
  assert.deepEqual(reports, []);
  assert.equal(calls.length, 0);
  const record = adapter.requests.get(key);
  assert.equal(record.state, 'completed');
  assert.equal(record.history.at(-1).text, 'Final recorded result.');
});
