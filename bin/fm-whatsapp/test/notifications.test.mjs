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

test('first AFK observation baselines outcomes but immediately captures an open decision', t => {
  const { policy } = fixture(t);
  const historic = [event('done'), event('failed', 'failure'), event('working', 'progress'), event('open', 'decision')];
  assert.deepEqual(policy.plan({ ...snapshot(historic), afk: false, session: '' }, 999), []);
  const initial = policy.plan(snapshot(historic), 1000);
  assert.equal(initial.length, 1); assert.deepEqual(initial[0].sourceIds, ['open']);
  policy.commit(initial[0]);
  assert.deepEqual(policy.plan(snapshot(historic), 1001), []);
  const delivery = policy.plan(snapshot([...historic, event('new')]), 1002);
  assert.equal(delivery.length, 1); assert.equal(delivery[0].sourceIds[0], 'new');
  assert.equal(policy.allow(delivery[0], { ...snapshot(), afk: false, session: '' }, 1002), false);
  assert.equal(policy.allow(delivery[0], snapshot([], 'away-2'), 1002), false);
  // A session change drops pending work and baselines outcomes already present.
  assert.deepEqual(policy.plan(snapshot([...historic, event('new')], 'away-2'), 1003), []);
});

test('an initial AFK snapshot still surfaces a current open decision', t => {
  const { policy } = fixture(t);
  const planned = policy.plan(snapshot([event('open-now', 'decision')]), 1);
  assert.equal(planned.length, 1); assert.deepEqual(planned[0].sourceIds, ['open-now']);
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
  assert.equal(first.length, 2); assert.equal(first[0].kind, 'digest');
  assert.deepEqual(new Set(first.flatMap(page => page.sourceIds)), new Set(['x', 'd']));
  const retry = new NotificationPolicy(root).plan(snapshot([event('x'), event('d', 'decision')]), 4700);
  assert.equal(retry[0].id, first[0].id);
  for (const page of first) restarted.commit(page);
  assert.deepEqual(new NotificationPolicy(root).plan(snapshot([event('x'), event('d', 'decision')]), 4800), []);
});

test('multipart digests preserve complete text and commit only their own page', t => {
  const { root, policy } = fixture(t);
  policy.command('digest 1'); policy.plan(snapshot([]), 1);
  const sources = [1, 2, 3].map(number => ({
    ...event(`page-${number}`), text: `${number}:${String(number).repeat(1680)}:end-${number}`
  }));
  assert.deepEqual(policy.plan(snapshot(sources), 2), []);
  const pages = policy.plan(snapshot(sources), 62);
  assert.equal(pages.length, 2);
  assert.ok(pages.every(page => page.text.length <= 3500));
  for (const source of sources) {
    const owners = pages.filter(page => page.sourceIds.includes(source.id));
    assert.equal(owners.length, 1); assert.ok(owners[0].text.includes(source.text));
  }
  assert.equal(pages[0].event, null);
  policy.commit(pages[0]);
  const afterRestart = new NotificationPolicy(root).plan(snapshot(sources), 63);
  assert.equal(afterRestart.length, 1);
  assert.deepEqual(afterRestart[0].sourceIds, pages[1].sourceIds);
  assert.equal(afterRestart[0].text, pages[1].text);
  policy.commit(afterRestart[0]);
  assert.deepEqual(new NotificationPolicy(root).plan(snapshot(sources), 64), []);
});

test('oversize source events are rejected instead of truncated and acknowledged', t => {
  const { policy } = fixture(t); policy.plan(snapshot([]), 1);
  assert.throws(() => policy.plan(snapshot([{ ...event('huge'), text: 'x'.repeat(3501) }]), 2), /exceeds 3500/);
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

test('digest pages pack whole events up to exactly 3500 characters and never split or truncate one', t => {
  const { root, policy } = fixture(t);
  policy.command('digest 1'); policy.plan(snapshot([]), 1);
  // 18 prefix + 2 bullet + 3480 fills a page exactly; markup cannot fit 3481.
  const full = { ...event('fills-page'), text: 'f'.repeat(3480) };
  const markupUnfit = { ...event('unfit'), text: 'u'.repeat(3481) };
  const small = event('small', 'failure');
  assert.deepEqual(policy.plan(snapshot([full, markupUnfit, small]), 2), []);
  const pages = policy.plan(snapshot([full, markupUnfit, small]), 62);
  assert.equal(pages.length, 3);
  assert.equal(pages[0].kind, 'digest');
  assert.deepEqual(pages[0].sourceIds, ['fills-page']);
  assert.equal(pages[0].text.length, 3500);
  assert.ok(pages[0].text.includes(full.text));
  // A source that fits WhatsApp but not digest markup stays whole and unchanged.
  assert.deepEqual(pages[1].sourceIds, ['unfit']);
  assert.equal(pages[1].kind, 'completion'); assert.deepEqual(pages[1].event, markupUnfit);
  assert.equal(pages[1].text, markupUnfit.text);
  assert.equal(pages[2].kind, 'digest'); assert.deepEqual(pages[2].sourceIds, ['small']);
  for (const page of pages) assert.ok(page.text.length <= 3500);
  // The whole uncommitted batch replays byte-identically after a restart.
  const replay = new NotificationPolicy(root).plan(snapshot([full, markupUnfit, small]), 63);
  assert.deepEqual(replay.map(page => [page.id, page.text, page.sourceIds]),
    pages.map(page => [page.id, page.text, page.sourceIds]));
});

test('uncommitted urgent decisions suppress duplicates until commit, then stay silent', t => {
  const { root, policy } = fixture(t);
  policy.plan(snapshot([]), 1);
  const first = policy.plan(snapshot([event('choice', 'decision')]), 2);
  assert.equal(first.length, 1);
  for (const tick of [3, 4]) {
    const again = new NotificationPolicy(root).plan(snapshot([event('choice', 'decision')]), tick);
    assert.deepEqual(again.map(item => [item.id, item.text, item.sourceIds]),
      first.map(item => [item.id, item.text, item.sourceIds]));
  }
  policy.commit(first[0]);
  assert.deepEqual(policy.plan(snapshot([event('choice', 'decision')]), 5), []);
  assert.deepEqual(new NotificationPolicy(root).plan(snapshot([event('choice', 'decision')]), 6), []);
});

test('urgent decisions captured during quiet hours wait for the quiet window to close', t => {
  const { policy } = fixture(t);
  policy.command('quiet 22:00-08:00 UTC');
  policy.plan(snapshot([]), Date.parse('2026-03-04T21:59:00Z') / 1000);
  // Captured durably during quiet hours; never bypassed while quiet.
  assert.deepEqual(policy.plan(snapshot([event('open', 'decision')], 's'),
    Date.parse('2026-03-04T23:30:00Z') / 1000), []);
  assert.equal(policy.allow({ session: 's', automatic: true, sourceEvents: [event('open', 'decision')] },
    snapshot([event('open', 'decision')]), Date.parse('2026-03-04T23:30:00Z') / 1000), false);
  // Lossless: the same open decision delivers immediately after quiet ends.
  const after = policy.plan(snapshot([event('open', 'decision')], 's'),
    Date.parse('2026-03-05T08:00:00Z') / 1000);
  assert.equal(after.length, 1); assert.deepEqual(after[0].sourceIds, ['open']);
  assert.equal(policy.allow(after[0], snapshot([event('open', 'decision')], 's'),
    Date.parse('2026-03-05T08:00:00Z') / 1000), true);
  policy.commit(after[0]);
  assert.deepEqual(policy.plan(snapshot([event('open', 'decision')], 's'),
    Date.parse('2026-03-05T09:00:00Z') / 1000), []);
});

test('pending digest work expires at the AFK boundary and is never delivered late', t => {
  const { policy } = fixture(t);
  policy.command('digest 60'); policy.command('alerts decisions urgent off');
  policy.plan(snapshot([]), 100);
  assert.deepEqual(policy.plan(snapshot([event('batched')], 'away-1'), 101), []);
  // AFK ends before the digest timer; the captured pending alert must not cross
  // the session boundary and returning cannot resurrect it.
  assert.deepEqual(policy.plan({ schema: 'fm-whatsapp-events.v1', afk: false, session: '',
    events: [event('batched')] }, 5000), []);
  assert.deepEqual(policy.plan(snapshot([event('batched')], 'away-1'), 5001), []);
  // A replacement session baselines historical outcomes instead of alerting them.
  assert.deepEqual(policy.plan(snapshot([event('batched')], 'away-2'), 5002), []);
  // A genuinely new outcome in the replacement session is captured, then waits
  // out its own full digest interval before the page can fire.
  assert.deepEqual(policy.plan(snapshot([event('batched'), event('new-one')], 'away-2'), 5003), []);
  const fresh = policy.plan(snapshot([event('batched'), event('new-one')], 'away-2'), 5003 + 3600);
  assert.deepEqual(fresh.map(item => item.sourceIds), [['new-one']]);
});

test('preferences persist exact values across restarts and damaged files fail closed precisely', t => {
  const { root, policy } = fixture(t);
  policy.command('alerts progress on');
  policy.command('unsubscribe project alpha');
  policy.command('subscribe task task-a');
  policy.command('quiet 22:00-08:00 America/New_York');
  policy.command('digest 15');
  const file = path.join(root, 'notification-preferences.json');
  const restored = new NotificationPolicy(root).preferences();
  assert.equal(restored.digestMinutes, 15);
  assert.deepEqual(restored.kinds, { completion: true, failure: true, decision: true, progress: true });
  assert.equal(restored.projects.alpha, false); assert.equal(restored.tasks['task-a'], true);
  assert.deepEqual(restored.quiet, { from: '22:00', to: '08:00', start: 1320, end: 480,
    timezone: 'America/New_York' });
  // A schema-bearing but incomplete file is damage: refuse with the precise
  // stored-preferences error instead of an opaque TypeError in every operation.
  fs.writeFileSync(file, JSON.stringify({ schema: 'fm-whatsapp-notifications.v1' }));
  const damaged = new NotificationPolicy(root);
  assert.throws(() => damaged.preferences(), /invalid notification preferences/);
  assert.throws(() => damaged.plan(snapshot([]), 1), /invalid notification preferences/);
  assert.throws(() => damaged.command('alerts on'), /invalid notification preferences/);
  // The damaged file is never silently overwritten with defaults.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).kinds, undefined);
});
