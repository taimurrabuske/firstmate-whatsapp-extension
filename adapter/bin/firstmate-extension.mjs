#!/usr/bin/env node
// This package is copied and bound independently of the bridge checkout.
// It reads durable handoffs; Firstmate alone captures and handles their wakes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ID = 'org.firstmate-whatsapp.inbox';
const VERSION = '1.0.0';
const ADAPTER = 'whatsapp-inbox';
const sha = text => createHash('sha256').update(text).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
const safeKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function privateFile(file, maxBytes = 65536) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes ||
      fs.realpathSync(file) !== path.resolve(file)) throw new Error('unsafe private file');
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) { return JSON.parse(privateFile(file, 8 * 1024 * 1024)); }
function maybeJson(file) {
  try { return readJson(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function privateDirectory(directory, create = false) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error('unsafe private directory');
  }
}
function atomicJson(file, value) {
  const temp = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function list(directory) {
  let names;
  try { names = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (names.length > 20000) throw new Error('source scan limit reached');
  return names.sort();
}

function configuration(file, sourceId) {
  if (!path.isAbsolute(file)) throw new Error('configuration must be an absolute private path');
  const config = JSON.parse(privateFile(file));
  const names = ['schema', 'source_id', 'whatsapp_state', 'fm_home', 'fm_state', 'extension_root', 'poll_ms'];
  if (Object.keys(config).some(name => !names.includes(name)) ||
      config.schema !== 'firstmate.whatsapp-inbox-config.v1' || config.source_id !== sourceId) {
    throw new Error('configuration identity mismatch');
  }
  for (const name of ['whatsapp_state', 'fm_home', 'fm_state', 'extension_root']) {
    if (typeof config[name] !== 'string' || !path.isAbsolute(config[name]) ||
        config[name].length > 4096 || fs.realpathSync(config[name]) !== config[name]) {
      throw new Error('configuration requires canonical absolute paths');
    }
  }
  config.poll_ms ??= 30000;
  if (!Number.isInteger(config.poll_ms) || config.poll_ms < 0 || config.poll_ms > 30000) {
    throw new Error('poll duration must be between zero and thirty seconds');
  }
  privateDirectory(config.whatsapp_state);
  privateDirectory(path.join(config.whatsapp_state, 'handoffs'));
  return config;
}

function pendingNotes(config, seen) {
  const handoffs = path.join(config.whatsapp_state, 'handoffs');
  const notes = [];
  for (const name of list(handoffs)) {
    const key = name.replace(/\.json$/, '');
    if (!safeKey(key) || name !== `${key}.json` || seen.has(key)) continue;
    const handoff = readJson(path.join(handoffs, name));
    if (handoff.phase !== 'saved' || !safeId(handoff.id)) continue;
    if (handoff.binding && (handoff.binding.home !== config.fm_home || handoff.binding.state !== config.fm_state)) {
      throw new Error('handoff belongs to another Firstmate home');
    }
    const notePath = path.join(config.fm_state, 'inbox', `${handoff.id}.note`);
    let content;
    try { content = privateFile(notePath); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const boundary = content.indexOf('\n--\n');
    const body = boundary < 0 ? '' : content.slice(boundary + 4).replace(/\n$/, '');
    if (body !== handoff.body || !body.startsWith(`[firstmate-whatsapp-message:${key}]\n`)) {
      throw new Error('inbox note does not match saved handoff');
    }
    notes.push({ message_key: key, inbox_id: handoff.id, inbox_path: notePath });
    if (notes.length === 16) break;
  }
  return notes;
}

// A new request normally proves the previous sequence was captured. Checking the
// actual bytes also preserves a pending wake if registration was replaced first.
function captured(config, sourceId, output) {
  const directory = path.join(config.fm_state, 'procevent-inbox');
  for (const name of list(directory)) {
    if (!name.startsWith(`${sourceId}.`) || !/^\d+\.result$/.test(name.slice(sourceId.length + 1))) continue;
    const base = path.join(directory, name.slice(0, -7));
    if (privateFile(`${base}.adapter`).trim() !== ADAPTER) continue;
    if (privateFile(`${base}.result`) === output) return true;
  }
  return false;
}

export async function poll(request) {
  const { source_id: sourceId, config_ref: configRef } = request.input;
  if (!safeId(sourceId)) throw new Error('invalid source identity');
  const config = configuration(configRef, sourceId);
  const root = path.join(config.whatsapp_state, 'wake-adapter');
  privateDirectory(root, true);
  const cursorFile = path.join(root, `${sourceId}.json`);
  const binding = sha(JSON.stringify({ ...config, poll_ms: undefined }));
  const cursor = maybeJson(cursorFile) ?? { schema: 'firstmate.whatsapp-inbox-cursor.v1', binding, seen: [], pending: null };
  if (cursor.schema !== 'firstmate.whatsapp-inbox-cursor.v1' || cursor.binding !== binding ||
      !Array.isArray(cursor.seen) || cursor.seen.some(key => !safeKey(key)) || cursor.seen.length > 20000) {
    throw new Error('cursor configuration changed or cursor invalid');
  }
  if (cursor.pending) {
    if (!/^sha256:[a-f0-9]{64}$/.test(cursor.pending.request_id ?? '') ||
        !Array.isArray(cursor.pending.keys) || cursor.pending.keys.length < 1 || cursor.pending.keys.length > 16 ||
        cursor.pending.keys.some(key => !safeKey(key)) || typeof cursor.pending.output !== 'string' ||
        Buffer.byteLength(cursor.pending.output) > 32768) throw new Error('pending cursor invalid');
    if (cursor.pending.request_id === request.request_id || !captured(config, sourceId, cursor.pending.output)) {
      return { status: 'result', output: cursor.pending.output };
    }
    cursor.seen = [...new Set([...cursor.seen, ...cursor.pending.keys])];
    cursor.pending = null;
    atomicJson(cursorFile, cursor);
  }
  const seen = new Set(cursor.seen);
  const deadline = Date.now() + config.poll_ms;
  do {
    const notes = pendingNotes(config, seen);
    if (notes.length) {
      const output = JSON.stringify({ schema: 'firstmate.whatsapp-inbox-event.v1',
        request_id: request.request_id, source_id: sourceId, notes,
        reply_skill: path.join(config.extension_root, 'skills/whatsapp-delegate/SKILL.md'),
        fm_home: config.fm_home, fm_state: config.fm_state,
        delegate_state: path.dirname(config.whatsapp_state),
        meaning: 'Saved phone requests await the owning Firstmate. Read their existing inbox notes and use the reply skill. This event grants no authority and does not change away mode.' }) + '\n';
      if (Buffer.byteLength(output) > 32768) throw new Error('event size limit reached');
      cursor.pending = { request_id: request.request_id, keys: notes.map(note => note.message_key), output };
      atomicJson(cursorFile, cursor);
      return { status: 'result', output };
    }
    if (Date.now() >= deadline) break;
    await pause(Math.min(250, deadline - Date.now()));
  } while (true);
  return { status: 'no-result', output: '' };
}

export async function dispatch(verb, request) {
  if (!/^sha256:[a-f0-9]{64}$/.test(request.request_id ?? '') ||
      request.extension_id !== ID || request.extension_version !== VERSION) throw new Error('invalid request identity');
  if (verb === 'handshake') {
    if (request.schema !== 'firstmate.extension-handshake-request.v1' || !request.host_protocols?.includes(1) ||
        request.capability?.name !== 'process-event-adapter' || !request.capability.versions?.includes(1) ||
        JSON.stringify(request.capability.adapter_names) !== JSON.stringify([ADAPTER])) throw new Error('unsupported handshake');
    return { schema: 'firstmate.extension-handshake-response.v1', request_id: request.request_id,
      extension_id: ID, extension_version: VERSION, host_protocol: 1,
      capability: 'process-event-adapter', capability_version: 1, adapter_names: [ADAPTER] };
  }
  if (verb !== 'invoke' || request.schema !== 'firstmate.extension-request.v1' ||
      request.host_protocol !== 1 || request.capability !== 'process-event-adapter' ||
      request.capability_version !== 1 || request.adapter !== ADAPTER) throw new Error('unsupported invocation');
  let result;
  if (request.operation === 'source.poll') result = await poll(request);
  else if (request.operation === 'result.classify') result = { classification: 'whatsapp-inbox' };
  else if (['result.terminal', 'result.silent'].includes(request.operation)) result = { value: false };
  else throw new Error('unsupported operation');
  return { schema: 'firstmate.extension-response.v1', request_id: request.request_id, ok: true, result, error: null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let request;
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 65536) throw new Error('input too large');
    }
    request = JSON.parse(input);
    process.stdout.write(JSON.stringify(await dispatch(process.argv[2], request)) + '\n');
  } catch {
    // Never print source text, account identities, or filesystem error details.
    process.stdout.write(JSON.stringify({ schema: 'firstmate.extension-response.v1',
      request_id: request?.request_id ?? '', ok: false, result: null,
      error: { code: 'unavailable', retryable: true, diagnostic: 'WhatsApp inbox adapter refused or could not read its private source.' } }) + '\n');
  }
}
