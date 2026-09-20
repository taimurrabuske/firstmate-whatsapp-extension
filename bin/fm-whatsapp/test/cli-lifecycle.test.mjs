import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionDisposition, reconnectDelay } from '../cli.mjs';
import { telegramConfigured } from '../telegram.mjs';
import { Store, writeJson, readJson } from '../core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const driver = path.join(here, 'cli-lifecycle-driver.mjs');

function runLifecycle(t, scenario) {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', driver, scenario],
    { encoding: 'utf8', timeout: 120000, cwd: path.dirname(driver) });
  const line = (result.stderr ?? '').split('\n').find(l => l.startsWith('DRIVER_RESULT '));
  assert.ok(line, `driver produced no result (status ${result.status}):\n${result.stderr}\n${result.stdout}`);
  return { summary: JSON.parse(line.slice('DRIVER_RESULT '.length)), stderr: result.stderr ?? '' };
}

test('run with a configured fallback stays alive and is serviced across QR rotation, reconnect and a loggedOut close', t => {
  const { summary } = runLifecycle(t, 'startup-qr');
  assert.ok(summary.timelineComplete, 'run stopped on the QR/re-pair path instead of keeping the fallback serviced');
  assert.ok(summary.socketCount >= 2, 'QR timeout close must take the reconnect disposition and open a new socket');
  assert.match(summary.health?.problem ?? '', /pairing required/);
  assert.equal(summary.health?.connected, false);
  assert.equal(summary.sent, 1);
  assert.ok(summary.telegramCalls.includes('sendMessage'));
  const sentNames = summary.cliLogs.join('\n');
  assert.ok(!sentNames.includes('session is unavailable'), 'a configured fallback must not take the stop branch');
});

test('run keeps a configured fallback serviced when the linked session is lost (loggedOut close)', t => {
  const { summary } = runLifecycle(t, 'logout');
  assert.ok(summary.timelineComplete, 'loggedOut close stopped the run instead of keeping the fallback serviced');
  assert.match(summary.health?.problem ?? '', /login required; Telegram fallback enabled/);
  assert.equal(summary.health?.connected, false);
  assert.equal(summary.sent, 1);
  assert.ok(summary.telegramCalls.includes('sendMessage'));
});

test('a transiently unreadable token file at the pairing moment never stops a configured fallback', t => {
  const { summary } = runLifecycle(t, 'token-blip');
  assert.ok(summary.timelineComplete, 'run stopped on a QR event while the fallback was configured; the tick owns degraded fallback service');
  assert.equal(summary.health?.problem, 'WhatsApp pairing required; Telegram fallback enabled');
  assert.ok(summary.telegramCalls.includes('getUpdates'), 'tick must keep polling');
  assert.equal(summary.sent, 1, 'fallback delivery must recover once the token file is readable again');
  assert.equal(summary.telegramHealth?.problem, '', 'tick health must clear after the token recovers');
});

test('a QR challenge that resolves without re-pairing restores the connected bridge', t => {
  const { summary } = runLifecycle(t, 'recovery');
  assert.ok(summary.timelineComplete);
  assert.equal(summary.health?.connected, true);
  assert.equal(summary.health?.problem, '');
  assert.equal(summary.sent, 0, 'WhatsApp remains the primary transport after recovery');
});

test('an unconfigured fallback preserves the pairing-required shutdown', t => {
  const { summary, stderr } = runLifecycle(t, 'unconfigured');
  assert.equal(summary.timelineComplete, false, 'run must stop on a QR event without a configured fallback');
  assert.match(summary.health?.problem ?? '', /pairing required/);
  assert.equal(summary.sent, 0);
  assert.equal(summary.telegramCalls.length, 0);
  assert.ok(!stderr.includes('Telegram remains available'));
});

test('connection disposition and reconnect backoff', () => {
  const reasons = { loggedOut: 401, badSession: 500, connectionReplaced: 440, forbidden: 403,
    connectionClosed: 428, timedOut: 408, restartRequired: 515, multideviceMismatch: 411 };
  for (const code of [401, 500, 440, 403]) assert.equal(connectionDisposition(code, reasons), 'stop');
  for (const code of [428, 408, 515, 411, 503, undefined, null]) assert.equal(connectionDisposition(code, reasons), 'reconnect');
  assert.equal(reconnectDelay(0), 1000);
  assert.equal(reconnectDelay(1), 2000);
  assert.equal(reconnectDelay(3), 8000);
  assert.equal(reconnectDelay(6), 60000);
  assert.equal(reconnectDelay(50), 60000);
});

test('telegramConfigured decides on the durable configuration alone', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-telegram-configured-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = new Store(base, path.join(base, 'private'));
  const tokenFile = path.join(base, 'token');
  fs.writeFileSync(tokenFile, `123456:${'a'.repeat(30)}`, { mode: 0o600 });
  assert.equal(telegramConfigured(store), false, 'nothing configured');
  writeJson(store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30 });
  assert.equal(telegramConfigured(store), true, 'configured, token file unreadable state does not matter');
  fs.chmodSync(tokenFile, 0o644);
  assert.equal(telegramConfigured(store), true, 'configured even while the token file is transiently unreadable');
  fs.chmodSync(tokenFile, 0o600);
  writeJson(store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: false,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30 });
  assert.equal(telegramConfigured(store), false, 'explicitly disabled');
  fs.rmSync(store.file('telegram.json'));
  fs.writeFileSync(store.file('telegram.json'), '{not json', { mode: 0o600 });
  assert.equal(telegramConfigured(store), false, 'unreadable private state is not a configuration');
});
