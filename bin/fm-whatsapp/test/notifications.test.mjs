import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationPolicy } from '../notifications.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wa-notifications-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, policy: new NotificationPolicy({ stateDir: root }) };
}
const event = (id, kind = 'completion', task = 'task-a', project = 'alpha') =>
  ({ id, kind, task, project, text: `${kind} ${id}` });
const snapshot = (events = [], session = 'away-1') => ({ schema: 'fm-whatsapp-events.v1', afk: true, session, events });

// 2026-01-15 04:00Z is 23:00 on the previous day in New York.
test('overnight quiet hours use the explicit IANA timezone', t => {
  const { policy } = fixture(t);
  assert.equal(policy.command('quiet 22:00-08:00 America/New_York').recognized, true);
  policy.plan(snapshot([]), Date.parse('2026-01-15T03:59:00Z') / 1000);
  assert.deepEqual(policy.plan(snapshot([event('one')]), Date.parse('2026-01-15T04:00:00Z') / 1000), []);
  const morning = policy.plan(snapshot([event('one')]), Date.parse('2026-01-15T14:00:00Z') / 1000);
  assert.equal(morning.length, 1);
  assert.equal(policy.allow(morning[0], snapshot([event('one')]), Date.parse('2026-01-15T14:00:00Z') / 1000), true);
  assert.equal(policy.allow(morning[0], snapshot([event('one')]), Date.parse('2026-01-15T04:00:00Z') / 1000), false);
});

test('first observation is a baseline and later events require AFK', t => {
  const { policy } = fixture(t);
  assert.deepEqual(policy.plan(snapshot([event('historic')]), 1000), []);
  assert.deepEqual(policy.plan(snapshot([event('historic')]), 1001), []);
  const delivery = policy.plan(snapshot([event('historic'), event('new')]), 1002);
  assert.equal(delivery.length, 1); assert.equal(delivery[0].sourceIds[0], 'new');
  assert.equal(policy.allow(delivery[0], { ...snapshot(), afk: false, session: '' }, 1002), false);
  assert.equal(policy.allow(delivery[0], snapshot([], 'away-2'), 1002), false);
  // A session change drops the pending old-session delivery and never revives it.
  assert.deepEqual(policy.plan(snapshot([event('historic'), event('new')], 'away-2'), 1003), []);
});

test('commands are exact, durable, and subscriptions have task precedence', t => {
  const { root, policy } = fixture(t);
  assert.equal(policy.command('please subscribe project alpha').recognized, false);
  assert.equal(policy.command('alerts progress on').recognized, true);
  assert.equal(policy.command('unsubscribe project alpha').recognized, true);
  assert.equal(policy.command('subscribe task task-a').recognized, true);
  policy.plan(snapshot([]), 1);
  const planned = policy.plan(snapshot([event('a', 'progress'), event('b', 'completion', 'task-b')]), 2);
  assert.deepEqual(planned.map(item => item.sourceIds[0]), ['a']);
  const restarted = new NotificationPolicy(root);
  assert.match(restarted.command('alerts').text, /progress on/);
  assert.equal(restarted.command('quiet 25:00-08:00 UTC').recognized, false);
  const badZone = restarted.command('quiet 22:00-08:00 Mars\/Base');
  assert.equal(badZone.recognized, true); assert.equal(badZone.error, true);
});

test('digest capture survives restart and retries until explicit commit', t => {
  const { root, policy } = fixture(t);
  policy.command('digest 60');
  policy.command('alerts decisions urgent off');
  policy.plan(snapshot([]), 1000);
  assert.deepEqual(policy.plan(snapshot([event('x'), event('d', 'decision')]), 1010), []);
  const restarted = new NotificationPolicy(root);
  assert.deepEqual(restarted.plan(snapshot([event('x'), event('d', 'decision')]), 4609), []);
  const first = restarted.plan(snapshot([event('x'), event('d', 'decision')]), 4610);
  assert.equal(first.length, 1); assert.equal(first[0].kind, 'digest');
  assert.deepEqual(new Set(first[0].sourceIds), new Set(['x', 'd']));
  const retry = new NotificationPolicy(root).plan(snapshot([event('x'), event('d', 'decision')]), 4700);
  assert.equal(retry[0].id, first[0].id);
  restarted.commit(first[0]);
  assert.deepEqual(new NotificationPolicy(root).plan(snapshot([event('x'), event('d', 'decision')]), 4800), []);
});

test('urgent decisions bypass digest but remain retryable and expire when resolved', t => {
  const { policy } = fixture(t);
  policy.command('digest 60'); policy.plan(snapshot([]), 10);
  const delivery = policy.plan(snapshot([event('decision-1', 'decision')]), 11);
  assert.equal(delivery.length, 1); assert.equal(delivery[0].kind, 'decision');
  assert.equal(policy.plan(snapshot([event('decision-1', 'decision')]), 12)[0].id, delivery[0].id);
  assert.equal(policy.allow(delivery[0], snapshot([]), 12), false);
  assert.deepEqual(policy.plan(snapshot([]), 13), []);
});

test('a policy change cancels captured digest work rather than replaying it later', t => {
  const { policy } = fixture(t);
  policy.command('digest 60'); policy.plan(snapshot([]), 1);
  policy.plan(snapshot([event('pending')]), 2);
  policy.command('alerts completion off');
  assert.deepEqual(policy.plan(snapshot([event('pending')]), 4000), []);
  policy.command('alerts completion on');
  assert.deepEqual(policy.plan(snapshot([event('pending')]), 8000), []);
});
