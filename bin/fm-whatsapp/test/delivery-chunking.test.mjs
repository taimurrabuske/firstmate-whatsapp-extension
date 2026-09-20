// Transport-size boundary regressions: deterministic Unicode-safe chunking,
// ordered multi-part delivery with stable retry identity, safe truncation,
// and consistent help across WhatsApp and the bound Telegram fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, Bridge, readJson, writeJson, sha256, chunkText, truncateText, safeBoundaryEnd,
  outboundOrder, REMOTE_HELP, MAX_TEXT } from '../core.mjs';
import { FirstmateAdapter } from '../firstmate.mjs';
import { RequestJournal } from '../requests.mjs';
import { TelegramDelegate, TelegramClient, telegramConfig } from '../telegram.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const route = { account: '15555550123@s.whatsapp.net', recipient: '15555550123@s.whatsapp.net' };
const batch = (...messages) => ({ type: 'notify', messages });

const loneSurrogate = text => {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next < 0xDC00 || next > 0xDFFF) return true;
      index++;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return true;
  }
  return false;
};

test('chunkText is deterministic, lossless, bounded, and never splits pairs or CRLF', () => {
  const samples = [
    'plain ascii text',
    'a'.repeat(3499) + '😀' + 'b'.repeat(500),
    '😀'.repeat(900),
    'x'.repeat(200) + '\r\n' + 'y'.repeat(400) + '\r\n' + 'z',
    '🎉'.repeat(1750), // pair-aligned length equal to the limit
    'tail-pair-finale' + '😁'
  ];
  for (const text of samples) for (const limit of [2, 3, 7, 100, 1024, 3500]) {
    const chunks = chunkText(text, limit);
    assert.equal(chunks.join(''), text, `lossless at limit ${limit}`);
    assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= limit), `bounded at limit ${limit}`);
    assert.ok(chunks.every(chunk => !loneSurrogate(chunk)), `pair-safe at limit ${limit}`);
    assert.deepEqual(chunkText(text, limit), chunks, 'deterministic');
  }
  assert.deepEqual(chunkText('short', 3500), ['short']);
  assert.deepEqual(chunkText('', 10), ['']);
  assert.throws(() => chunkText('text', 1), /invalid chunk/);
  assert.throws(() => chunkText(42, 10), /invalid chunk/);
  const [head, ...rest] = chunkText('a'.repeat(9) + '\r\n' + 'b'.repeat(20), 10);
  assert.ok(!head.endsWith('\r'), 'CRLF is never split');
  assert.ok(rest.join('').startsWith('\r\n'));
});

test('safeBoundaryEnd and truncateText leave no lone surrogate behind', () => {
  const text = 'a'.repeat(9) + '😀' + 'b';
  assert.equal(safeBoundaryEnd(text, 0, 10), 9); // high surrogate at 9 backs the boundary off
  assert.equal(safeBoundaryEnd(text, 0, 11), 11); // pair fully inside the range
  assert.equal(truncateText(text, 10), 'a'.repeat(9));
  assert.equal(truncateText(text, 11), text.slice(0, 11));
  assert.equal(truncateText(text, 4), 'aaaa');
  assert.equal(truncateText('plain', 3), 'pla');
  assert.throws(() => truncateText('text', 0), /invalid truncate/);
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-chunking-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'firstmate'));
  const state = path.join(home, 'delegate');
  const store = new Store(path.join(home, 'firstmate'), state);
  return { home, state, store };
}

function bridgeFixture(t) {
  const f = fixture(t);
  let now = 1000;
  const sends = [];
  const bridge = new Bridge({ store: f.store, clock: () => now,
    events: async () => ({ schema: 'fm-whatsapp-events.v1', afk: false, session: '', events: [] }),
    inbox: async () => {}, status: async () => 'status', summary: async () => 'summary',
    send: async (jid, text, id) => { sends.push({ text, id }); return true; } });
  bridge.connect({ id: route.account });
  return { ...f, bridge, sends, advance: seconds => { now += seconds; }, now: () => now };
}

const message = (text, id) => ({ key: { id, remoteJid: route.account, fromMe: true },
  messageTimestamp: 1001, message: { conversation: text } });

test('request pages are pair-safe and reconstruct the record across more', t => {
  const f = fixture(t);
  fs.writeFileSync(f.store.file('identity.json'), JSON.stringify({ account: route.account, pairedAt: 1 }));
  const requests = new RequestJournal(f.store);
  const key = 'a'.repeat(64);
  const header = `Remote request ${key.slice(0, 12)} — lifecycle state: received\nRequest: `;
  const text = 'x'.repeat(3300 - header.length - 1) + '😀' + 'y'.repeat(100);
  requests.receive(key, { route, text });
  const row = requests.requestRow(requests.get(key));
  let page = requests.summarize('pending', route);
  const pages = [];
  for (;;) {
    assert.ok(page.length <= 3500);
    assert.ok(!loneSurrogate(page), 'no page carries a lone surrogate');
    const more = page.includes('Send more');
    pages.push(page.replace(/\nSend more for the next recorded page\.$/, ''));
    if (!more) break;
    page = requests.summarize('more', route);
  }
  assert.ok(pages.length >= 2);
  assert.equal(pages.join(''), `${row}\n`);
  assert.equal(readJson(requests.cursorFile(route)).kind, 'done');
});

test('text pagination is pair-safe and the more cursor completes', t => {
  const f = fixture(t);
  fs.writeFileSync(f.store.file('identity.json'), JSON.stringify({ account: route.account, pairedAt: 1 }));
  const requests = new RequestJournal(f.store);
  const body = 'y'.repeat(3299) + '🙂' + 'y'.repeat(50);
  let page = requests.paginateText('status', route, body);
  const pages = [];
  for (;;) {
    assert.ok(!loneSurrogate(page));
    const more = page.includes('Send more');
    pages.push(page.replace(/\nSend more for the next recorded page\.$/, ''));
    if (!more) break;
    page = requests.summarize('more', route);
  }
  assert.equal(pages.length, 2);
  assert.equal(pages.join(''), body);
});

test('recent-context excerpts keep pairs whole at both cut points', t => {
  const f = fixture(t);
  fs.writeFileSync(f.store.file('identity.json'), JSON.stringify({ account: route.account, pairedAt: 1 }));
  const requests = new RequestJournal(f.store);
  // floor(700 * 0.7) is 489: put one pair ending exactly at 489 so a naive head
  // cut keeps it whole only by luck, and put another exactly at the tail opening.
  const text = 'z'.repeat(487) + '😀' + 'm'.repeat(100) + '😐' + 'w'.repeat(207);
  requests.receive('e'.repeat(64), { route, text });
  requests.transition('e'.repeat(64), 'completed', 'a compact final result');
  const context = requests.recentContext(route, { exclude: 'f'.repeat(64) });
  assert.ok(context.includes('😀'), 'head cut keeps the whole pair');
  assert.ok(context.includes('😐'), 'tail opening keeps the whole pair');
  assert.ok(!loneSurrogate(context));
});

test('the summary safety bound truncates on a whole-character boundary', async t => {
  const f = bridgeFixture(t);
  f.bridge.summary = async () => 's'.repeat(3499) + '😀' + '!';
  await f.bridge.receive(batch(message('!fm status', 'SUMMARY1')));
  const job = readJson(f.store.file(`outbox/${f.store.records('outbox')[0]}`));
  assert.ok(!loneSurrogate(job.text));
  assert.ok(job.text.length <= MAX_TEXT);
  assert.ok(job.text.startsWith('sss'));
});

test('help output is identical on WhatsApp and the Telegram fallback', async t => {
  const f = bridgeFixture(t);
  await f.bridge.receive(batch(message('help', 'HELP1')));
  await f.bridge.processPending();
  const whatsappJob = readJson(f.store.file(`outbox/${f.store.records('outbox')[0]}`));
  assert.equal(whatsappJob.text, REMOTE_HELP);

  const tokenFile = path.join(f.home, 'token');
  fs.writeFileSync(tokenFile, `123456:${'a'.repeat(30)}`, { mode: 0o600 });
  writeJson(f.store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30,
    whatsappRoute: f.store.currentRoute() });
  const telegramSends = [];
  const config = telegramConfig(f.store);
  const delegate = new TelegramDelegate({ store: f.store, adapter: {}, clock: () => 1000,
    command: async () => null,
    clientFactory: () => ({ updates: async () => [], send: async text => { telegramSends.push(text); return 'TG_1'; } }) });
  const pendingKey = sha256('telegram\nhelp');
  fs.mkdirSync(f.store.file('telegram-pending'), { recursive: true });
  writeJson(f.store.file(`telegram-pending/${pendingKey}.json`), { key: pendingKey, text: 'help', remoteId: 'TG_9',
    route: config.route, attempts: 0, next: 0 });
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(telegramSends.at(-1), `[Firstmate] ${REMOTE_HELP}`);
});

test('multi-part replies keep whole characters, ordered parts, and stable retry identity', t => {
  const f = fixture(t);
  const home = path.join(f.home, 'firstmate');
  const codeRoot = path.join(home, 'code'), state = path.join(home, 'state');
  fs.writeFileSync(f.store.file('identity.json'), JSON.stringify({ account: route.account, pairedAt: 1 }));
  const adapter = new FirstmateAdapter({ home, codeRoot, state, store: f.store, extensionRoot, run: async () => '' });
  const publish = (requestKey, id, text) => {
    adapter.requests.receive(requestKey, { route, text });
    const body = adapter.envelope(requestKey, text);
    writeJson(f.store.file(`handoffs/${requestKey}.json`), { id, body, phase: 'saved', route,
      binding: { home: fs.realpathSync(home), codeRoot: path.resolve(codeRoot), state: path.resolve(state) } });
    fs.mkdirSync(path.join(state, 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(state, 'inbox', `${id}.note`), `id=${id}\nat=2026-01-01\nsource=text\n--\n${body}\n`);
  };
  const key = 'b'.repeat(64);
  publish(key, 'note-1', `request ${key.slice(0, 8)}`);

  // A surrogate pair and a CRLF straddle the 3500 boundary between parts.
  const text = 'A'.repeat(3499) + '😀' + '\r\n' + 'B'.repeat(710);
  const queued = adapter.reply(key, text);
  assert.ok(queued);
  const jobs = f.store.records('outbox').map(name => readJson(f.store.file(`outbox/${name}`)))
    .sort((a, b) => outboundOrder(a, b));
  assert.equal(jobs.length, 2);
  assert.equal(jobs.map(job => job.text).join(''), text, 'parts concatenate losslessly');
  assert.ok(jobs.every(job => job.text.length <= MAX_TEXT && !loneSurrogate(job.text)));
  assert.ok(jobs.every(job => job.part && job.part.count === 2 && job.part.family === `${key}:${sha256(text)}`));
  assert.deepEqual(jobs.map(job => job.part.index), [1, 2]);
  assert.ok(jobs.every(job => job.requestKey === key));
  // Identity is a pure function of (key, text, index): identical replay dedupes.
  adapter.reply(key, text);
  assert.equal(f.store.records('outbox').length, 2);
  assert.throws(() => adapter.reply(key, `${text} changed`), /already completed/);
  assert.equal(adapter.requests.get(key).state, 'completed');
  assert.equal(adapter.requests.get(key).history.at(-1).text, text);

  // A single-part reply keeps the legacy queue identity unchanged.
  const singleKey = 'c'.repeat(64);
  publish(singleKey, 'note-2', 'another request');
  assert.throws(() => adapter.reply(singleKey, 'x'.repeat(MAX_TEXT * 4 + 1)), /invalid reply text/);
  adapter.reply(singleKey, 'Compact result.');
  const legacy = f.store.records('outbox').map(name => readJson(f.store.file(`outbox/${name}`)))
    .find(job => job.text === 'Compact result.');
  assert.equal(legacy.eventId, `response:${singleKey}:${sha256('Compact result.')}`);
  assert.equal(legacy.part, undefined);
});

test('outbox delivery follows enqueue order, never filename hash order', async t => {
  const f = bridgeFixture(t);
  for (const label of ['part-1', 'part-2', 'part-3', 'part-4', 'part-5']) {
    f.store.enqueue(label, { kind: 'reply', session: '', id: label });
  }
  const hashOrder = f.store.records('outbox').map(name => readJson(f.store.file(`outbox/${name}`)).text);
  assert.notDeepEqual(hashOrder, ['part-1', 'part-2', 'part-3', 'part-4', 'part-5'],
    'filename order genuinely differs, so this test is meaningful');
  for (let index = 0; index < 5; index++) {
    await f.bridge.flush();
    f.advance(3);
  }
  assert.deepEqual(f.sends.map(send => send.text),
    ['[Firstmate] part-1', '[Firstmate] part-2', '[Firstmate] part-3', '[Firstmate] part-4', '[Firstmate] part-5']);
});

test('a retrying part holds its later parts without blocking unrelated replies', async t => {
  const f = bridgeFixture(t);
  let failPartTwo = true;
  const failing = 'head UNDELIVERABLE ' + '.'.repeat(10);
  f.bridge.send = async (jid, text, id) => {
    if (failPartTwo && text.includes('UNDELIVERABLE')) return false;
    f.sends.push({ text, id });
    return true;
  };
  f.store.enqueue('first part', { kind: 'reply', session: '', id: 'p1',
    part: { family: 'fam', index: 1, count: 3 } });
  f.store.enqueue(failing, { kind: 'reply', session: '', id: 'p2',
    part: { family: 'fam', index: 2, count: 3 } });
  f.store.enqueue('third part', { kind: 'reply', session: '', id: 'p3',
    part: { family: 'fam', index: 3, count: 3 } });
  f.store.enqueue('unrelated reply', { kind: 'reply', session: '', id: 'solo' });

  await f.bridge.flush(); f.advance(3); // part one delivered
  await f.bridge.flush(); f.advance(2); // part two attempt one fails; backoff two seconds
  await f.bridge.flush(); f.advance(2); // part two attempt two fails; backoff four seconds
  assert.deepEqual(f.sends.map(send => send.text), ['[Firstmate] first part']);
  await f.bridge.flush(); f.advance(3); // part two still waiting: part three holds, unrelated flows
  assert.deepEqual(f.sends.map(send => send.text),
    ['[Firstmate] first part', '[Firstmate] unrelated reply']);
  failPartTwo = false;
  await f.bridge.flush(); f.advance(3); // part two confirmed on retry
  await f.bridge.flush(); f.advance(3); // then part three, never before part two
  assert.deepEqual(f.sends.map(send => send.text),
    ['[Firstmate] first part', '[Firstmate] unrelated reply', `[Firstmate] ${failing}`, '[Firstmate] third part']);
});

test('telegram fallback delivers bound jobs in enqueue order too', async t => {
  const f = fixture(t);
  const tokenFile = path.join(f.home, 'token');
  fs.writeFileSync(tokenFile, `123456:${'a'.repeat(30)}`, { mode: 0o600 });
  writeJson(f.store.file('identity.json'), { account: route.account, pairedAt: 1 });
  writeJson(f.store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30,
    whatsappRoute: f.store.currentRoute() });
  const fallback = { transport: 'telegram', account: 'telegram:123456', recipient: 'telegram:1234',
    credentialDigest: sha256(`123456:${'a'.repeat(30)}`) };
  for (const label of ['tg-1', 'tg-2', 'tg-3']) {
    f.store.enqueue(label, { kind: 'reply', session: '', id: label, fallbackRoute: fallback });
  }
  const hashOrder = f.store.records('outbox').map(name => readJson(f.store.file(`outbox/${name}`)).text);
  assert.notDeepEqual(hashOrder, ['tg-1', 'tg-2', 'tg-3'], 'hash order must genuinely differ');
  writeJson(f.store.file('telegram-offline.json'), { since: 900 });
  const sends = [];
  const delegate = new TelegramDelegate({ store: f.store, adapter: {}, clock: () => 1000,
    clientFactory: () => ({ updates: async () => [], send: async text => { sends.push(text); return 'TG_1'; } }) });
  const snapshot = { afk: false, session: '', events: [] };
  await delegate.tick({ connected: false }, snapshot);
  await delegate.tick({ connected: false }, snapshot);
  await delegate.tick({ connected: false }, snapshot);
  assert.deepEqual(sends, ['[Firstmate] tg-1', '[Firstmate] tg-2', '[Firstmate] tg-3']);
});

test('telegram document captions truncate on whole characters', async t => {
  const captured = [];
  const client = new TelegramClient({ token: 'x', chatId: '777' }, async (url, options) => {
    captured.push(options.body);
    return { ok: true, text: async () => JSON.stringify({ ok: true, result: { message_id: 5, chat: { id: 777 } } }) };
  });
  const caption = 'c'.repeat(1023) + '😀' + 'd'.repeat(50);
  await client.send(caption, { data: Buffer.from('bytes'), mime: 'text/plain', name: 'a.txt' });
  const sent = captured[0].get('caption');
  assert.ok(!loneSurrogate(sent));
  assert.ok(sent.length <= 1024);
  assert.equal(sent, 'c'.repeat(1023));
});
