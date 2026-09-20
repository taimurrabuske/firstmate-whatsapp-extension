import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, readJson, writeJson } from '../core.mjs';
import { authenticatedTelegram, configureTelegram, telegramConfig, telegramStore, TelegramDelegate, TelegramClient } from '../telegram.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-telegram-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = new Store(base, path.join(base, 'private'));
  writeJson(store.file('identity.json'), { account: '15555550123@s.whatsapp.net' });
  const tokenFile = path.join(base, 'token');
  fs.writeFileSync(tokenFile, `123456:${'a'.repeat(30)}`, { mode: 0o600 });
  writeJson(store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30, whatsappRoute: store.currentRoute() });
  return { base, store, tokenFile, config: telegramConfig(store) };
}
const update = (changes = {}) => ({ update_id: 2, message: { message_id: 10, date: 999,
  chat: { id: 1234, type: 'private' }, from: { id: 1234, is_bot: false }, text: 'Check the simulation', ...changes } });

test('Telegram admits only the explicitly paired private person and rejects forwards/stale/spoofed input', t => {
  const f = fixture(t);
  assert.ok(authenticatedTelegram(update(), f.config, 1000));
  for (const change of [{ chat: { id: 1234, type: 'group' } }, { from: { id: 999 } },
    { forward_origin: {} }, { date: 800 }, { date: 999999 }, { from: { id: 1234, is_bot: true } },
    { text: '' }, { via_bot: {} }]) assert.equal(authenticatedTelegram(update(change), f.config, 1000), null);
  assert.equal(authenticatedTelegram({ edited_message: update().message }, f.config, 1000), null);
});

test('Telegram configuration keeps tokens private and pins bot and recipient identity', async t => {
  const f = fixture(t);
  assert.equal(telegramStore(f.store).currentRoute().recipient, 'telegram:1234');
  assert.ok(!JSON.stringify(f.config.route).includes('a'.repeat(30)));
  fs.chmodSync(f.tokenFile, 0o644);
  assert.throws(() => telegramConfig(f.store));
  fs.chmodSync(f.tokenFile, 0o600);
  await configureTelegram(f.store, f.tokenFile, '1234', { now: 1000, fetcher: async () =>
    ({ ok: true, text: async () => JSON.stringify({ ok: true, result: { is_bot: true, id: 123456 } }) }) });
  assert.equal(readJson(f.store.file('telegram.json')).enabledAt, 900);
  assert.equal(fs.statSync(f.store.file('telegram.json')).mode & 0o777, 0o600);
});

test('Telegram API errors never reveal the token or remote body', async () => {
  const client = new TelegramClient({ token: 'secret', chatId: '1234' }, async () => { throw new Error('secret'); });
  await assert.rejects(client.send('hi'), error => !error.message.includes('secret'));
});

test('Telegram cursor persists intake before handoff and retries same request without acting twice', async t => {
  const f = fixture(t); let calls = 0, fail = true, now = 1000;
  const client = { updates: async offset => offset > 2 ? [] : [update()], send: async () => 'TG_20' };
  const adapter = { note: async key => { calls++; if (fail) throw new Error('offline'); assert.ok(f.store.incoming(key)); }, status: async () => 'status' };
  const delegate = new TelegramDelegate({ store: f.store, adapter, clientFactory: () => client, clock: () => now });
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(readJson(f.store.file('telegram-cursor.json')).offset, 3);
  assert.equal(f.store.records('telegram-pending').length, 1);
  fail = false; now += 16;
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(calls, 2);
  assert.equal(f.store.records('telegram-pending').length, 0);
  assert.equal(f.store.records('sent').length, 1);
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(calls, 2);
});

test('Fallback waits for WhatsApp outage and retains AFK-only alert gating', async t => {
  const f = fixture(t); let now = 1000; const sends = [];
  const delegate = new TelegramDelegate({ store: f.store, adapter: {}, clock: () => now,
    clientFactory: () => ({ updates: async () => [], send: async text => { sends.push(text); return 'TG_20'; } }) });
  f.store.enqueue('answer', { kind: 'reply', session: '', route: f.store.currentRoute(), fallbackRoute: f.config.route });
  await delegate.tick({ connected: true }, { afk: false });
  now += 10; await delegate.tick({ connected: false }, { afk: false });
  assert.equal(sends.length, 0);
  now += 30; await delegate.tick({ connected: false }, { afk: false });
  assert.equal(sends.length, 1);
  f.store.enqueue('proactive', { session: 'afk-session', fallbackRoute: f.config.route });
  now += 30; await delegate.tick({ connected: false }, { afk: false });
  assert.equal(sends.length, 1);
  await delegate.tick({ connected: false }, { afk: true, session: 'afk-session' });
  assert.equal(sends.length, 2);
});

test('An absent Telegram configuration makes no requests', async t => {
  const f = fixture(t); fs.unlinkSync(f.store.file('telegram.json'));
  const delegate = new TelegramDelegate({ store: f.store, adapter: {}, clientFactory: () => { throw new Error('must not call'); } });
  await delegate.tick({ connected: false }, { afk: false });
  assert.equal(readJson(f.store.file('telegram-health.json')), null);
});

test('fallback cannot adopt unbound old jobs or move a bound reply after token rotation', async t => {
  const f = fixture(t); let now = 1000; const sends = [];
  const delegate = new TelegramDelegate({ store: f.store, adapter: {}, clock: () => now,
    clientFactory: () => ({ updates: async () => [], send: async text => { sends.push(text); return 'TG_30'; } }) });
  f.store.enqueue('old unbound answer', { kind: 'reply', session: '', route: f.store.currentRoute() });
  f.store.enqueue('bound answer', { kind: 'reply', session: '', route: f.store.currentRoute(), fallbackRoute: f.config.route });
  await delegate.tick({ connected: true }, { afk: false });
  fs.writeFileSync(f.tokenFile, `123456:${'b'.repeat(30)}`);
  now += 60; await delegate.tick({ connected: false }, { afk: false });
  assert.equal(sends.length, 0); assert.equal(f.store.records('outbox').length, 2);
});
