// Repository-owned installation for this extension. It is the single way the
// pieces that run outside this checkout are produced: the staged inbox adapter
// package Firstmate binds, the adapter's source configuration, and the systemd
// user unit that supervises the bridge. It never changes Firstmate's own state:
// binding and registering an extension belong to the Firstmate owner, so an
// unbound or outdated binding is reported with the exact commands to run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { delegateState } from './core.mjs';

export const EXTENSION_ID = 'org.firstmate-whatsapp.inbox';
export const ADAPTER_NAME = 'whatsapp-inbox';
export const SOURCE_ID = 'whatsapp-inbox-main';
export const UNIT_NAME = 'firstmate-whatsapp.service';
const CONFIG_SCHEMA = 'firstmate.whatsapp-inbox-config.v1';
const ADAPTER_FILES = ['firstmate-extension.json', 'bin/firstmate-extension.mjs'];

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Content identity of the adapter as this checkout ships it.
export function adapterIdentity(extensionRoot) {
  const source = path.join(extensionRoot, 'adapter');
  const files = ADAPTER_FILES.map(name => ({ name, bytes: fs.readFileSync(path.join(source, name)) }));
  const manifest = JSON.parse(files[0].bytes.toString('utf8'));
  const tree = crypto.createHash('sha256');
  for (const file of files) tree.update(`${file.name}\0${file.bytes.length}\0`).update(file.bytes);
  return { source, files, version: manifest.version, entrypointSha256: `sha256:${sha256(files[1].bytes)}`,
    treeDigest: tree.digest('hex') };
}

export function installPaths({ home, env = process.env }) {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const state = delegateState(home, env);
  return {
    stageRoot: path.join(dataHome, 'firstmate-whatsapp'),
    state,
    adapterConfig: env.WHATSAPP_ADAPTER_CONFIG || path.join(state, 'inbox-adapter.json'),
    unit: path.join(configHome, 'systemd/user', UNIT_NAME),
    binding: path.join(env.FM_CONFIG_OVERRIDE || path.join(home, 'config'), 'extensions.d', `${EXTENSION_ID}.json`),
  };
}

export function stageDirectory(stageRoot, identity) {
  return path.join(stageRoot, `inbox-adapter-${identity.version}-${identity.treeDigest.slice(0, 12)}`);
}

function sameFiles(directory, identity) {
  return identity.files.every(file => {
    try { return fs.readFileSync(path.join(directory, file.name)).equals(file.bytes); } catch { return false; }
  });
}

// Stages the adapter into a content-named directory. An existing directory is
// reused only when its bytes match; a mismatch is refused, never overwritten.
export function stageAdapter(stageRoot, identity, { apply = true } = {}) {
  const directory = stageDirectory(stageRoot, identity);
  if (fs.existsSync(directory)) {
    if (!sameFiles(directory, identity)) throw new Error(`staged adapter ${directory} differs from this checkout; inspect it`);
    return { directory, changed: false };
  }
  if (!apply) return { directory, changed: true };
  fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(stageRoot, '.staging-'));
  try {
    fs.mkdirSync(path.join(temporary, 'bin'), { mode: 0o755 });
    for (const file of identity.files) {
      const target = path.join(temporary, file.name);
      fs.writeFileSync(target, file.bytes, { flag: 'wx' });
      fs.chmodSync(target, file.name.endsWith('.mjs') ? 0o755 : 0o644);
    }
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, directory);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return { directory, changed: true };
}

export function adapterConfig({ home, env = process.env, state, extensionRoot }) {
  const canonical = file => fs.realpathSync(file);
  return {
    schema: CONFIG_SCHEMA,
    source_id: SOURCE_ID,
    whatsapp_state: canonical(path.join(state, 'whatsapp')),
    fm_home: canonical(home),
    fm_state: canonical(env.FM_STATE_OVERRIDE || path.join(home, 'state')),
    extension_root: canonical(extensionRoot),
    poll_ms: 30000,
  };
}

// Writes the source configuration once. An existing file is compared and
// reported; it is never rewritten, because a live registration references it.
export function ensureAdapterConfig(file, config, { apply = true } = {}) {
  let current = null;
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') return { state: 'unreadable' };
  }
  if (current) {
    const differing = Object.keys(config).filter(key => current[key] !== config[key]);
    return differing.length ? { state: 'differs', differing } : { state: 'matches' };
  }
  if (apply) fs.writeFileSync(file, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: 'wx' });
  return { state: 'written' };
}

export function renderUnit({ extensionRoot, home, node = process.execPath, env = process.env }) {
  const template = fs.readFileSync(path.join(extensionRoot, 'systemd', `${UNIT_NAME}.in`), 'utf8');
  const extra = ['FM_CODE_ROOT', 'FM_STATE_OVERRIDE', 'FM_DELEGATE_STATE']
    .filter(name => env[name] && path.isAbsolute(env[name]))
    .map(name => `Environment=${name}=${env[name]}\n`).join('');
  return template
    .replaceAll('@EXTENSION_ROOT@', fs.realpathSync(extensionRoot))
    .replaceAll('@FM_HOME@', fs.realpathSync(home))
    .replaceAll('@NODE@', node)
    .replace('@EXTRA_ENVIRONMENT@\n', extra);
}

export function unitStatus(file, rendered) {
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
  if (current === null) return 'absent';
  return current === rendered ? 'current' : 'differs';
}

// Compares Firstmate's enabled binding with the adapter this checkout stages.
export function bindingStatus(bindingFile, identity, stage) {
  let binding = null;
  try { binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { state: 'unbound' };
    return { state: 'unreadable' };
  }
  const current = binding.entrypoint_sha256 === identity.entrypointSha256 && binding.source?.path === stage;
  return { state: current ? 'current' : 'outdated', boundPath: binding.source?.path ?? null,
    boundEntrypoint: binding.entrypoint_sha256 ?? null };
}

function transportResolves(extensionRoot) {
  const requireModule = createRequire(path.join(extensionRoot, 'bin/fm-whatsapp', 'package.json'));
  try { for (const name of ['@whiskeysockets/baileys', 'qrcode-terminal']) requireModule.resolve(name); return true; }
  catch { return false; }
}

export function bindCommands({ codeRoot, stage, configFile }) {
  return [
    `"${codeRoot}/bin/fm-extension.sh" bind "${stage}" --adapter ${ADAPTER_NAME} --trust-same-user-code --consent task-metadata --timeout-ms 45000`,
    `"${codeRoot}/bin/fm-procevent.sh" register-extension ${ADAPTER_NAME} ${SOURCE_ID} --config-ref "${configFile}"`,
    `"${codeRoot}/bin/fm-procevent.sh" reconcile`,
  ];
}

// Upgrade order is Firstmate's retirement contract: the source registration
// goes first (it depends on the binding), then the binding, then the new pair.
// The registration record names the binding digest it depends on; the token
// stays in that file and is never printed.
export function registeredBindingDigest(stateDir) {
  try {
    const text = fs.readFileSync(path.join(stateDir, 'procevent', `${SOURCE_ID}.source`), 'utf8');
    const match = /^binding_digest=(sha256:[a-f0-9]{64})$/m.exec(text);
    return match ? match[1] : null;
  } catch { return null; }
}

export function upgradeCommands({ codeRoot, stage, configFile, fmState = path.join(codeRoot, 'state') }) {
  const digest = registeredBindingDigest(fmState) ?? '<binding digest printed by the original bind>';
  return [
    `"${codeRoot}/bin/fm-procevent.sh" list   # confirm ${SOURCE_ID} shows PENDING 0 before retiring`,
    `"${codeRoot}/bin/fm-procevent.sh" retire ${SOURCE_ID} --if-owner <registration_token from ${path.join(fmState, 'procevent', `${SOURCE_ID}.source`)}>`,
    `node "${codeRoot}/bin/fm-extension.mjs" retire-binding ${EXTENSION_ID} --if-binding-digest ${digest}`,
    ...bindCommands({ codeRoot, stage, configFile }),
  ];
}

export function install({ home, env = process.env, extensionRoot, systemd = false, apply = true,
  node = process.execPath, runNpm = args => spawnSync('npm', args, { stdio: 'inherit' }).status }) {
  const lines = [];
  const say = line => lines.push(line);
  const codeRoot = env.FM_CODE_ROOT || home;
  const paths = installPaths({ home, env });

  if (transportResolves(extensionRoot)) say('ok: transport dependencies are installed');
  else if (!apply) say('pending: transport dependencies would be installed with npm ci');
  else {
    const status = runNpm(['ci', '--ignore-scripts', '--prefix', path.join(extensionRoot, 'bin/fm-whatsapp')]);
    if (status !== 0) throw new Error('npm ci failed for the transport dependencies');
    say('changed: installed transport dependencies with npm ci');
  }

  const identity = adapterIdentity(extensionRoot);
  const staged = stageAdapter(paths.stageRoot, identity, { apply });
  say(`${staged.changed ? (apply ? 'changed' : 'pending') : 'ok'}: inbox adapter ${identity.version} staged at ${staged.directory}`);

  if (!fs.existsSync(path.join(paths.state, 'whatsapp'))) {
    say('pending: pair the bridge first; the adapter configuration needs its private state');
  } else {
    const config = ensureAdapterConfig(paths.adapterConfig,
      adapterConfig({ home, env, state: paths.state, extensionRoot }), { apply });
    if (config.state === 'written') say(`${apply ? 'changed' : 'pending'}: adapter configuration written to ${paths.adapterConfig}`);
    else if (config.state === 'matches') say('ok: adapter configuration matches this checkout');
    else if (config.state === 'differs') say(`problem: adapter configuration ${paths.adapterConfig} differs (${config.differing.join(', ')}); it is never rewritten while registered; re-register after correcting it`);
    else say(`problem: adapter configuration ${paths.adapterConfig} is unreadable; inspect it`);
  }

  const unit = renderUnit({ extensionRoot, home, node, env });
  const unitState = unitStatus(paths.unit, unit);
  if (unitState === 'current') say(`ok: systemd user unit ${paths.unit} is current`);
  else if (!systemd) say(`note: systemd user unit is ${unitState}; rerun with --systemd to write ${paths.unit}`);
  else if (!apply) say(`pending: systemd user unit ${paths.unit} would be ${unitState === 'absent' ? 'created' : 'updated'}`);
  else {
    fs.mkdirSync(path.dirname(paths.unit), { recursive: true });
    fs.writeFileSync(paths.unit, unit, { mode: 0o644 });
    say(`changed: wrote ${paths.unit}; run: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_NAME} && systemctl --user restart ${UNIT_NAME}`);
  }

  const binding = bindingStatus(paths.binding, identity, staged.directory);
  const commandArgs = { codeRoot, stage: staged.directory, configFile: paths.adapterConfig,
    fmState: env.FM_STATE_OVERRIDE || path.join(home, 'state') };
  if (binding.state === 'current') say('ok: Firstmate binds the adapter this checkout ships');
  else if (binding.state === 'unbound') {
    say('next: Firstmate has no binding for the inbox adapter; the Firstmate owner runs:');
    for (const command of bindCommands(commandArgs)) say(`  ${command}`);
  } else if (binding.state === 'outdated') {
    say(`next: Firstmate binds an older adapter (${binding.boundPath}); the Firstmate owner upgrades it with:`);
    for (const command of upgradeCommands(commandArgs)) say(`  ${command}`);
  } else say(`problem: Firstmate binding ${paths.binding} is unreadable; inspect it`);
  return { lines, paths, stage: staged.directory, identity, binding, unitState };
}
