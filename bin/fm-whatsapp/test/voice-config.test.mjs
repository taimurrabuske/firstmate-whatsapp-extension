// Operator CLI for private offline voice configuration: set/inspect/remove lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../cli.mjs';
import { readJson } from '../core.mjs';
import { loadVoiceConfig, VOICE_CONFIG_SCHEMA } from '../voice.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'bin/fm-whatsapp/cli.mjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-voice-config-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, FM_HOME: home, FM_DELEGATE_STATE: path.join(base, 'delegate-state'),
    XDG_STATE_HOME: path.join(base, 'xdg') };
  const tool = (name, mode = 0o700) => {
    const file = path.join(base, name); fs.writeFileSync(file, '#!/bin/false\\n', { mode }); return file;
  };
  const model = path.join(base, 'ggml-model.bin'); fs.writeFileSync(model, 'local weights', { mode: 0o600 });
  const run = (args, overrides = {}) => spawnSync(process.execPath, [cli, 'voice-config', ...args],
    { encoding: 'utf8', env: { ...env, ...(overrides.env ?? {}) } });
  return { base, home, env, ffmpeg: tool('ffmpeg'), whisper: tool('whisper-cli'),
    model, noexec: tool('noexec', 0o600), run, state: path.join(env.FM_DELEGATE_STATE, 'whatsapp') };
}

test('parseArgs accepts the three voice-config actions with exact arity', () => {
  assert.deepEqual(parseArgs(['voice-config', 'inspect']), { ...parseArgs(['voice-config', 'inspect']), command: 'voice-config', voiceAction: 'inspect', voicePaths: undefined });
  assert.equal(parseArgs(['voice-config', 'remove']).voiceAction, 'remove');
  const set = parseArgs(['voice-config', 'set', '/a/ffmpeg', '/a/whisper', '/a/model.bin', 'de']);
  assert.equal(set.voiceAction, 'set');
  assert.deepEqual(set.voicePaths, ['/a/ffmpeg', '/a/whisper', '/a/model.bin', 'de']);
  assert.equal(parseArgs(['voice-config', 'set', '/a', '/b', '/c']).voicePaths.length, 3);
  for (const bad of [['voice-config'], ['voice-config', 'reconfigure'], ['voice-config', 'inspect', 'extra'],
    ['voice-config', 'set', '/a', '/b'], ['voice-config', 'set', '/a', '/b', '/c', 'de', 'extra']]) {
    assert.throws(() => parseArgs(bad), /voice-config|invalid command/);
  }
});

test('set validates paths, writes private mode-600 state, and inspect reads it back', t => {
  const f = fixture(t);
  let result = f.run(['set', f.ffmpeg, f.whisper, f.model, 'en']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configured.*mode 600/s);
  const file = path.join(f.state, 'voice.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readJson(file), { schema: VOICE_CONFIG_SCHEMA, ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en' });
  result = f.run(['inspect']);
  assert.equal(result.status, 0, result.stderr);
  const inspected = JSON.parse(result.stdout);
  assert.equal(inspected.available, true);
  assert.equal(inspected.language, 'en');
  assert.equal(inspected.model, fs.realpathSync(f.model));
  assert.equal(loadVoiceConfig({ file: () => file }).available, true);
});

test('set defaults language to en and rewrites an existing configuration atomically', t => {
  const f = fixture(t);
  assert.equal(f.run(['set', f.ffmpeg, f.whisper, f.model]).status, 0);
  let result = f.run(['set', f.ffmpeg, f.whisper, f.model, 'fr']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /language fr/);
  assert.equal(JSON.parse(f.run(['inspect']).stdout).language, 'fr');
});

test('set refuses relative paths, symlinks, absent files, and non-executables without writing state', t => {
  const f = fixture(t);
  const link = path.join(f.base, 'model-link'); fs.symlinkSync(f.model, link);
  for (const bad of [['relative/ffmpeg', f.whisper, f.model], [f.ffmpeg, link, f.model],
    [f.ffmpeg, f.whisper, path.join(f.base, 'absent.bin')], [f.noexec, f.whisper, f.model]]) {
    const result = f.run(['set', ...bad]);
    assert.equal(result.status, 1);
    assert.ok(!fs.existsSync(path.join(f.state, 'voice.json')), `state written for ${bad[0]}`);
    // Validation failures stay intelligible to the operator without echoing arguments.
    assert.ok(!result.stdout.includes(bad[0]));
  }
  const staged = f.run(['set', f.ffmpeg, f.whisper, f.model]);
  assert.equal(staged.status, 0);
  const rejected = f.run(['set', f.ffmpeg, f.whisper, f.model, 'EN-US']);
  assert.equal(rejected.status, 1);
  assert.deepEqual(readJson(path.join(f.state, 'voice.json')),
    { schema: VOICE_CONFIG_SCHEMA, ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en' });
});

test('inspect reports an absent configuration as unavailable and remove is idempotent', t => {
  const f = fixture(t);
  assert.equal(JSON.parse(f.run(['inspect']).stdout).available, false);
  let result = f.run(['remove']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /was not present/);
  assert.equal(f.run(['set', f.ffmpeg, f.whisper, f.model]).status, 0);
  result = f.run(['remove']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed/);
  assert.ok(!fs.existsSync(path.join(f.state, 'voice.json')));
  assert.equal(JSON.parse(f.run(['inspect']).stdout).available, false);
});

test('voice-config requires an absolute FM_HOME and a fresh private state', t => {
  const f = fixture(t);
  const result = f.run(['inspect'], { env: { FM_HOME: 'relative/home' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fm-whatsapp: command failed/);
});
