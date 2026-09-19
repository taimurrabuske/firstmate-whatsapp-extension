import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const code = process.env.FM_TEST_CODE_ROOT;
test('unmodified Firstmate AFK and classifier interoperate without a new reach schema', {
  skip: !code && 'set FM_TEST_CODE_ROOT to an installed Firstmate for integration coverage'
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-extension-events-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home'), state = path.join(home, 'state');
  const delegate = path.join(temp, 'delegate');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(delegate, 'whatsapp'), { recursive: true });
  const env = { ...process.env, FM_HOME: home, FM_CODE_ROOT: code,
    FM_STATE_OVERRIDE: state, FM_DELEGATE_STATE: delegate, FM_ROOT_OVERRIDE: code };
  const invoke = (file, args = []) => spawnSync('bash', [file, ...args], { env, encoding: 'utf8' });
  const contract = (...args) => {
    const result = invoke(path.join(code, 'bin/fm-afk-contract.sh'), args);
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  const events = () => {
    const result = invoke(path.join(root, 'bin/fm-whatsapp-events.sh'), ['--json']);
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const enable = value => fs.writeFileSync(path.join(delegate, 'whatsapp/enabled.json'), JSON.stringify({ enabled: value }));
  assert.equal(events().afk, false);
  contract('propose'); contract('confirm');
  assert.equal(contract('field', 'reach_channels').trim(), 'none');
  const original = fs.readFileSync(path.join(state, '.afk-contract'));
  assert.equal(events().afk, false);
  enable(true);
  fs.writeFileSync(path.join(state, 'worker.meta'), 'kind=worker\n');
  fs.writeFileSync(path.join(state, 'worker.status'), 'needs-decision [key=choice]: Pick A or B\nworking: progress\n');
  fs.writeFileSync(path.join(state, 'retired.status'), 'needs-decision [key=old]: Ignore retired task\n');
  const result = events();
  assert.equal(result.afk, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].id, 'worker:choice');
  assert.match(result.events[0].text, /Pick A or B/);
  assert.deepEqual(fs.readFileSync(path.join(state, '.afk-contract')), original);
  fs.appendFileSync(path.join(state, 'worker.status'), 'resolved [key=choice]: Selected A\n');
  assert.deepEqual(events().events, []);
  enable(false); assert.equal(events().afk, false);
  enable(true); contract('archive'); assert.equal(events().afk, false);
  contract('propose'); contract('confirm');
  fs.writeFileSync(path.join(state, '.afk-contract'), 'broken record\n');
  assert.notEqual(invoke(path.join(root, 'bin/fm-whatsapp-events.sh'), ['--json']).status, 0);
});
