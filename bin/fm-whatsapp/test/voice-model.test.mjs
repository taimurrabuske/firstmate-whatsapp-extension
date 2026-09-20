// Independent private model store: explicit HTTPS install, pinned checksum
// verification, atomic private install, removal, and voice-config integration.
// All download paths use injected fetch implementations over local fixture
// bytes; no test performs a network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../cli.mjs';
import { Store, readJson } from '../core.mjs';
import { WHISPERCPP_REVISION, WHISPER_MODEL_CATALOG, catalogModels, installWhisperModel,
  modelFile, modelsDirectory, removeWhisperModel, resolveCatalogModel, whisperModelUrl } from '../model-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'bin/fm-whatsapp/cli.mjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-voice-model-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const store = new Store(home, path.join(base, 'delegate-state'));
  return { base, home, store, models: modelsDirectory(store) };
}

// A fetch implementation that serves local fixture bytes in bounded chunks as
// a web Response body. No sockets are involved.
function servingFetcher(payload, { chunkSize = 1024, status = 200, redirect = null, scheme = 'https:' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.equal(url.protocol, 'https:', 'fetch must only ever see HTTPS targets');
    if (calls.length === 1 && redirect) return new Response(null, { status: 302, headers: { location: redirect } });
    if (scheme !== 'https:') return new Response(null, { status: 302, headers: { location: `${scheme}//host/file` } });
    if (status !== 200) return new Response(null, { status });
    const body = Readable.toWeb(Readable.from(chunkSlice(payload, chunkSize)));
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function* chunkSlice(payload, size) { for (let at = 0; at < payload.length; at += size) yield payload.subarray(at, at + size); }

// A one-entry test catalog whose declared size and digest match local fixture
// bytes exactly, keeping download tests deterministic and offline.
function fixtureCatalog(name, payload, { digest } = {}) {
  return { [name]: { file: `ggml-${name}.bin`,
    sha256: digest ?? crypto.createHash('sha256').update(payload).digest('hex'), bytes: payload.length } };
}

test('catalog covers several supported models with pinned https provenance and valid digests', () => {
  const names = Object.keys(WHISPER_MODEL_CATALOG);
  assert.ok(names.length >= 2, 'selection must not be a single mandatory model');
  const files = new Set();
  for (const [name, entry] of Object.entries(WHISPER_MODEL_CATALOG)) {
    assert.match(name, /^[a-z0-9._-]{1,64}$/);
    assert.equal(entry.file, `ggml-${name}.bin`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0);
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0);
    assert.ok(!files.has(entry.file)); files.add(entry.file);
    const url = new URL(whisperModelUrl(name));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.host, 'huggingface.co');
    assert.ok(url.pathname.endsWith(`/resolve/${WHISPERCPP_REVISION}/${entry.file}`));
  }
});

test('install streams a matching fixture into private state atomically with mode 600 and no temporaries', async t => {
  const f = fixture(t);
  const payload = Buffer.alloc(8192, 7);
  const catalog = fixtureCatalog('tiny.en', payload);
  const fetcher = servingFetcher(payload);
  const result = await installWhisperModel('tiny.en', { store: f.store, fetchImpl: fetcher, catalog });
  assert.equal(result.alreadyInstalled, false);
  assert.equal(fetcher.calls.length, 1);
  const stat = fs.statSync(result.file);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(result.file).equals(payload), true);
  assert.equal(fs.statSync(f.models).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(f.models).filter(name => name.startsWith('.')), [], 'temporary files must be cleaned');
  // Reinstall is a verified no-op without a second download.
  const again = await installWhisperModel('tiny.en', { store: f.store, fetchImpl: fetcher, catalog });
  assert.equal(again.alreadyInstalled, true);
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fs.readFileSync(result.file).equals(payload), true);
});

test('install fails closed on checksum mismatch, truncation, and oversize, leaving private state untouched', async t => {
  for (const scenario of ['mismatch', 'truncated', 'oversize']) {
    const f = fixture(t);
    const payload = Buffer.alloc(2048, 3);
    const catalog = fixtureCatalog('base', payload, {
      digest: scenario === 'mismatch' ? crypto.createHash('sha256').update('other').digest('hex') : undefined });
    if (scenario === 'truncated') catalog.base.bytes += 1;
    const served = scenario === 'truncated' ? payload.subarray(0, 1024)
      : scenario === 'oversize' ? Buffer.concat([payload, Buffer.alloc(1, 1)]) : payload;
    const fetcher = servingFetcher(served);
    await assert.rejects(installWhisperModel('base', { store: f.store, fetchImpl: fetcher, catalog }), /model download failed/);
    assert.ok(!fs.existsSync(modelFile(f.store, 'base')), `final file written for ${scenario}`);
    assert.deepEqual(fs.readdirSync(f.models).filter(name => name.startsWith('.')), [], `temporary left for ${scenario}`);
    assert.equal(resolveCatalogModel(f.store, 'base'), null);
  }
});

test('install refuses non-HTTPS redirects, redirect loops, and HTTP error statuses', async t => {
  const f = fixture(t);
  const payload = Buffer.alloc(1024, 5);
  const catalog = fixtureCatalog('small', payload);
  const insecure = servingFetcher(payload, { redirect: 'http://huggingface.co/ggml-small.bin' });
  await assert.rejects(installWhisperModel('small', { store: f.store, fetchImpl: insecure, catalog }), /HTTPS/);
  assert.ok(!fs.existsSync(modelFile(f.store, 'small')));
  const loop = async () => new Response(null, { status: 302, headers: { location: 'https://huggingface.co/again' } });
  await assert.rejects(installWhisperModel('small', { store: f.store, fetchImpl: loop, catalog }), /redirect/);
  const failing = servingFetcher(payload, { status: 404 });
  await assert.rejects(installWhisperModel('small', { store: f.store, fetchImpl: failing, catalog }), /HTTP 404/);
  const offline = async () => { throw new Error('connect ECONNREFUSED'); };
  await assert.rejects(installWhisperModel('small', { store: f.store, fetchImpl: offline, catalog }), /model download failed/);
  assert.equal(offline.calls, undefined);
  assert.deepEqual(fs.readdirSync(f.models).filter(name => name.startsWith('.')), []);
});

test('a corrupted existing install is replaced only after the replacement verifies', async t => {
  const f = fixture(t);
  fs.writeFileSync(modelFile(f.store, 'base'), 'corrupted weights', { mode: 0o600 });
  const payload = Buffer.alloc(1024, 9);
  const catalog = fixtureCatalog('base', payload);
  const fetcher = servingFetcher(payload);
  await installWhisperModel('base', { store: f.store, fetchImpl: fetcher, catalog });
  assert.equal(fs.readFileSync(modelFile(f.store, 'base')).equals(payload), true);
  assert.equal(fetcher.calls.length, 1, 'corrupted install must be re-downloaded');
});

test('remove deletes only the named installed model and unknown names are refused', t => {
  const f = fixture(t);
  const file = modelFile(f.store, 'tiny.en');
  fs.writeFileSync(file, 'weights', { mode: 0o600 });
  assert.throws(() => removeWhisperModel('../../etc', { store: f.store }), /supported catalog model/);
  assert.throws(() => removeWhisperModel('nonexistent', { store: f.store }), /supported catalog model/);
  assert.equal(removeWhisperModel('tiny.en', { store: f.store }).removed, true);
  assert.ok(!fs.existsSync(file));
  assert.equal(removeWhisperModel('tiny.en', { store: f.store }).removed, false);
});

test('parseArgs accepts voice-model list, install NAME, and remove NAME with exact arity', () => {
  assert.equal(parseArgs(['voice-model', 'list']).voiceModelAction, 'list');
  const install = parseArgs(['voice-model', 'install', 'base.en']);
  assert.equal(install.voiceModelAction, 'install');
  assert.equal(install.voiceModelName, 'base.en');
  assert.equal(parseArgs(['voice-model', 'remove', 'tiny']).voiceModelAction, 'remove');
  for (const bad of [['voice-model'], ['voice-model', 'upgrade'], ['voice-model', 'list', 'extra'],
    ['voice-model', 'install'], ['voice-model', 'install', 'a', 'b'], ['voice-model', 'install', '../escape']]) {
    assert.throws(() => parseArgs(bad), /voice-model|invalid command/);
  }
});

test('voice-model list works offline and reports installed flags', t => {
  const f = fixture(t);
  const run = args => spawnSync(process.execPath, [cli, ...args],
    { encoding: 'utf8', env: { ...process.env, FM_HOME: f.home, FM_DELEGATE_STATE: path.join(f.base, 'delegate-state') } });
  let result = run(['voice-model', 'list']);
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(listed) && listed.length >= 2);
  assert.ok(listed.every(model => model.installed === false && new URL(whisperModelUrl(model.name)).protocol === 'https:'));
  fs.writeFileSync(path.join(f.models, 'ggml-tiny.en.bin'), 'weights', { mode: 0o600 });
  result = run(['voice-model', 'list']);
  assert.equal(JSON.parse(result.stdout).find(model => model.name === 'tiny.en').installed, true);
});

function cliFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-voice-model-cli-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, FM_HOME: home, FM_DELEGATE_STATE: path.join(base, 'delegate-state') };
  const tool = name => { const file = path.join(base, name); fs.writeFileSync(file, '#!/bin/false\n', { mode: 0o700 }); return file; };
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  return { base, home, env, ffmpeg: tool('ffmpeg'), whisper: tool('whisper-cli'), run, state: path.join(env.FM_DELEGATE_STATE, 'whatsapp') };
}

test('voice-config set accepts an installed model name and stores its private path; uninstalled names are refused', async t => {
  const f = cliFixture(t);
  // Refuse before install, without echoing the argument.
  let result = f.run(['voice-config', 'set', f.ffmpeg, f.whisper, 'base.en']);
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes('base.en') && !fs.existsSync(path.join(f.state, 'voice.json')));
  // Install through the module with a local fixture under the real file name,
  // then select it by name through the CLI without any network use.
  const store = new Store(f.home, path.join(f.base, 'delegate-state'));
  const payload = Buffer.alloc(1024, 11);
  const catalog = fixtureCatalog('base.en', payload);
  await installWhisperModel('base.en', { store, fetchImpl: servingFetcher(payload), catalog });
  result = f.run(['voice-config', 'set', f.ffmpeg, f.whisper, 'base.en', 'en']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configured.*mode 600/s);
  const written = readJson(path.join(f.state, 'voice.json'));
  assert.equal(written.model, modelFile(store, 'base.en'));
  assert.equal(written.language, 'en');
  // An absolute local path keeps working unchanged, and relative junk is refused.
  const local = path.join(f.base, 'local.bin');
  fs.writeFileSync(local, 'local weights', { mode: 0o600 });
  assert.equal(f.run(['voice-config', 'set', f.ffmpeg, f.whisper, local]).status, 0);
  assert.equal(readJson(path.join(f.state, 'voice.json')).model, local);
  result = f.run(['voice-config', 'set', f.ffmpeg, f.whisper, 'relative/model.bin']);
  assert.equal(result.status, 1);
  assert.equal(readJson(path.join(f.state, 'voice.json')).model, local);
  // voice-model install refuses unsupported names through the CLI without network use.
  result = f.run(['voice-model', 'install', 'made-up-model']);
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes('made-up-model'));
});

test('catalogModels reports paths inside the private state and resolveCatalogModel rejects absent files', t => {
  const f = fixture(t);
  for (const model of catalogModels(f.store)) {
    assert.ok(model.path.startsWith(f.models));
    assert.equal(model.installed, false);
  }
  assert.equal(resolveCatalogModel(f.store, 'large-v3'), null);
});
