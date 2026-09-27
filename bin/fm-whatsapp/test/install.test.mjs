import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, adapterIdentity, stageDirectory, installPaths, EXTENSION_ID, SOURCE_ID } from '../install.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fm-whatsapp-install-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, 'state/procevent'), { recursive: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const env = { XDG_DATA_HOME: path.join(base, 'data'), XDG_CONFIG_HOME: path.join(base, 'config'),
    FM_DELEGATE_STATE: path.join(base, 'delegate') };
  fs.mkdirSync(path.join(env.FM_DELEGATE_STATE, 'whatsapp'), { recursive: true });
  const run = (options = {}) => install({ home, env, extensionRoot, node: '/usr/bin/node',
    runNpm: () => { throw new Error('npm must not run when dependencies resolve'); }, ...options });
  return { base, home, env, run, paths: installPaths({ home, env }) };
}

test('install stages the adapter by content, writes its configuration once, and is idempotent', t => {
  const f = fixture(t);
  const first = f.run();
  const identity = adapterIdentity(extensionRoot);
  assert.equal(first.stage, stageDirectory(f.paths.stageRoot, identity));
  for (const name of ['firstmate-extension.json', 'bin/firstmate-extension.mjs'])
    assert.ok(fs.readFileSync(path.join(first.stage, name)).equals(fs.readFileSync(path.join(extensionRoot, 'adapter', name))));
  assert.equal(fs.statSync(path.join(first.stage, 'bin/firstmate-extension.mjs')).mode & 0o777, 0o755);
  const config = JSON.parse(fs.readFileSync(f.paths.adapterConfig, 'utf8'));
  assert.equal(config.source_id, SOURCE_ID);
  assert.equal(config.extension_root, fs.realpathSync(extensionRoot));
  assert.equal(fs.statSync(f.paths.adapterConfig).mode & 0o777, 0o600);
  assert.ok(first.lines.some(line => line.startsWith('changed: inbox adapter')));

  const second = f.run();
  assert.ok(second.lines.some(line => line.startsWith('ok: inbox adapter')));
  assert.ok(second.lines.includes('ok: adapter configuration matches this checkout'));
  assert.ok(!second.lines.some(line => line.startsWith('problem:')));
});

test('a registered configuration that differs is reported and never rewritten', t => {
  const f = fixture(t);
  f.run();
  const edited = { ...JSON.parse(fs.readFileSync(f.paths.adapterConfig, 'utf8')), extension_root: '/elsewhere' };
  fs.writeFileSync(f.paths.adapterConfig, JSON.stringify(edited));
  const result = f.run();
  assert.ok(result.lines.some(line => line.startsWith('problem: adapter configuration') && line.includes('extension_root')));
  assert.equal(JSON.parse(fs.readFileSync(f.paths.adapterConfig, 'utf8')).extension_root, '/elsewhere');
});

test('a staged directory whose bytes differ is refused rather than overwritten', t => {
  const f = fixture(t);
  const { stage } = f.run();
  fs.appendFileSync(path.join(stage, 'bin/firstmate-extension.mjs'), '// tampered\n');
  assert.throws(() => f.run(), /differs from this checkout/);
});

test('--systemd renders the unit from the repository template; without it the unit is only reported', t => {
  const f = fixture(t);
  const reported = f.run();
  assert.ok(reported.lines.some(line => line.startsWith('note: systemd user unit is absent')));
  assert.ok(!fs.existsSync(f.paths.unit));
  const written = f.run({ systemd: true, env: { ...f.env, FM_CODE_ROOT: '/opt/firstmate' } });
  const unit = fs.readFileSync(f.paths.unit, 'utf8');
  assert.match(unit, new RegExp(`^WorkingDirectory=${fs.realpathSync(extensionRoot)}$`, 'm'));
  assert.match(unit, new RegExp(`^Environment=FM_HOME=${f.home}$`, 'm'));
  assert.match(unit, /^Environment=FM_CODE_ROOT=\/opt\/firstmate$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node .*\/bin\/fm-whatsapp\/cli\.mjs run$/m);
  assert.ok(!unit.includes('@'));
  assert.ok(written.lines.some(line => line.startsWith('changed: wrote')));
  assert.equal(f.run({ systemd: true, env: { ...f.env, FM_CODE_ROOT: '/opt/firstmate' } }).unitState, 'current');
});

test('binding status drives bind, upgrade, or nothing, and never touches Firstmate state', t => {
  const f = fixture(t);
  const unbound = f.run();
  assert.equal(unbound.binding.state, 'unbound');
  assert.ok(unbound.lines.some(line => line.includes('fm-extension.sh" bind') && line.includes(unbound.stage)));

  fs.mkdirSync(path.dirname(f.paths.binding), { recursive: true });
  fs.writeFileSync(f.paths.binding, JSON.stringify({ extension_id: EXTENSION_ID, entrypoint_sha256: 'sha256:old',
    source: { kind: 'local-directory', path: '/old/stage' } }));
  const digest = `sha256:${'b'.repeat(64)}`;
  fs.writeFileSync(path.join(f.home, 'state/procevent', `${SOURCE_ID}.source`),
    `adapter=whatsapp-inbox\nbinding_digest=${digest}\nregistration_token=secret-token\n`);
  const outdated = f.run();
  assert.equal(outdated.binding.state, 'outdated');
  const text = outdated.lines.join('\n');
  assert.ok(text.indexOf(`retire ${SOURCE_ID}`) < text.indexOf('retire-binding'));
  assert.ok(text.indexOf('retire-binding') < text.indexOf('" bind '));
  assert.ok(text.includes(`--if-binding-digest ${digest}`));
  assert.ok(!text.includes('secret-token'));

  const identity = adapterIdentity(extensionRoot);
  fs.writeFileSync(f.paths.binding, JSON.stringify({ extension_id: EXTENSION_ID, entrypoint_sha256: identity.entrypointSha256,
    source: { kind: 'local-directory', path: outdated.stage } }));
  const current = f.run();
  assert.equal(current.binding.state, 'current');
  assert.ok(!current.lines.some(line => line.startsWith('next:')));
});

test('--dry-run writes nothing', t => {
  const f = fixture(t);
  const result = f.run({ apply: false, systemd: true });
  assert.ok(!fs.existsSync(f.paths.stageRoot));
  assert.ok(!fs.existsSync(f.paths.adapterConfig));
  assert.ok(!fs.existsSync(f.paths.unit));
  assert.ok(result.lines.some(line => line.startsWith('pending: inbox adapter')));
});
