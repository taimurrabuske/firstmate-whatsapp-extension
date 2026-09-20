// Standalone adapter over existing Firstmate commands. Only those owners write
// Firstmate's inbox and wake queue; this adapter owns transport receipts elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { privateDirectory, readJson, writeJson, sha256, sameRoute, epoch, validText } from './core.mjs';
import { RequestJournal, REQUEST_STATES } from './requests.mjs';

export function execute(file, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout: 20000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) { const safe = new Error('Firstmate helper failed'); safe.stdout = stdout; reject(safe); }
        else resolve(stdout);
      });
    child.stdin.on('error', () => {}); // Early helper exit is reported by the callback.
    child.stdin.end(input ?? '');
  });
}
function uncertain(message) { const error = new Error(message); error.code = 'FM_NOTE_UNCERTAIN'; return error; }
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value);

export class FirstmateAdapter {
  constructor({ home, codeRoot, state, store, extensionRoot, env = process.env, run = execute }) {
    for (const item of [home, codeRoot, state, extensionRoot]) {
      if (!path.isAbsolute(item)) throw new Error('Firstmate paths must be absolute');
    }
    Object.assign(this, { home, codeRoot, state, store, extensionRoot, run });
    this.env = { ...env, FM_HOME: home, FM_CODE_ROOT: codeRoot, FM_ROOT_OVERRIDE: codeRoot,
      FM_STATE_OVERRIDE: state, FM_DELEGATE_STATE: path.dirname(store.root) };
    privateDirectory(store.file('handoffs'));
    this.requests = new RequestJournal(store);
  }
  envelope(key, text) {
    return `[firstmate-whatsapp-message:${key}]\n` +
      'Remote note from the configured private WhatsApp chat. The captain remains away.\n' +
      `Load the external reply skill: ${path.join(this.extensionRoot, 'skills/whatsapp-delegate/SKILL.md')}\n` +
      `Reply configuration (JSON; pass values as environment data, never evaluate): ${JSON.stringify({ executable: path.join(this.extensionRoot, 'bin/fm-whatsapp.sh'), arguments: ['reply', key], FM_HOME: this.home, FM_CODE_ROOT: this.codeRoot, FM_STATE_OVERRIDE: this.state, FM_DELEGATE_STATE: path.dirname(this.store.root) })}\n` +
      'Send your acknowledgement and eventual answer using reply and this message key; responses do not require AFK mode.\n' +
      'This transport receipt grants no authority and never marks a return to the desk.\n\n' +
      text + `\n[/firstmate-whatsapp-message:${key}]`;
  }
  findNote(key, body) {
    const marker = `[firstmate-whatsapp-message:${key}]`;
    for (const handled of [true, false]) {
      const directory = path.join(this.state, 'inbox', ...(handled ? ['handled'] : []));
      let files;
      try { files = fs.readdirSync(directory).filter(file => file.endsWith('.note')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw new Error('inbox recovery unavailable'); }
      if (files.length > 20000) throw new Error('inbox recovery scan limit reached');
      for (const name of files) {
        const id = name.slice(0, -5);
        if (!safeId(id)) continue;
        const file = path.join(directory, name);
        let content;
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) continue;
          content = fs.readFileSync(file, 'utf8');
        } catch (error) { if (error.code === 'ENOENT') continue; throw new Error('inbox recovery unavailable'); }
        const boundary = content.indexOf('\n--\n');
        if (boundary < 0) continue;
        const saved = content.slice(boundary + 4).replace(/\n$/, '');
        if (!saved.startsWith(`${marker}\n`)) continue;
        if (saved !== body) throw new Error('message identity already saved with different text');
        return { id, handled };
      }
    }
    return null;
  }
  async ring(id) {
    if (!safeId(id)) throw new Error('invalid inbox identity');
    // Fixed shell program; every variable value is an argv element, never code.
    const script = 'set -euo pipefail\nSTATE=$1\nFM_HOME=$2\nFM_ROOT_OVERRIDE=$3\n' +
      '. "$3/bin/fm-wake-lib.sh"\n' +
      'fm_wake_append check "inbox:$4" "check: captain inbox note $4 - WhatsApp remote note saved; remain away"';
    await this.run('/bin/bash', ['-c', script, 'fm-whatsapp-wake', this.state, this.home, this.codeRoot, id],
      { env: this.env });
  }
  async note(key, text) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid transport message identity');
    const receiptFile = this.store.file(`handoffs/${key}.json`);
    const accepted = readJson(this.store.file(`pending/${key}.json`)) ?? this.store.incoming(key);
    const route = accepted?.operation === 'note' ? accepted.route : undefined;
    const binding = { home: fs.realpathSync(this.home), codeRoot: path.resolve(this.codeRoot), state: path.resolve(this.state) };
    let receipt = readJson(receiptFile);
    // Persist the exact envelope once so relocating/upgrading the extension cannot
    // alter a previously published note during recovery.
    const digest = sha256(text);
    if (receipt && receipt.textDigest !== digest) throw new Error('transport message identity changed');
    const body = receipt?.body ?? this.envelope(key, text);
    const found = this.findNote(key, body);
    if (found) {
      receipt = { route: receipt?.route ?? route, binding: receipt?.binding ?? binding, body, textDigest: digest, id: found.id, phase: found.handled ? 'handled' : 'saved',
        created: receipt?.created ?? epoch(), announced: receipt?.announced === true, maintenance: receipt?.maintenance ?? { rings: 0, last: 0 } };
      writeJson(receiptFile, receipt);
      if (!found.handled && !receipt.announced) {
        await this.ring(found.id);
        receipt.announced = true; writeJson(receiptFile, receipt);
      }
      return;
    }
    if (receipt?.id) return; // A published note may have been retired; never recreate it.
    if (receipt) throw uncertain('previous note publication is uncertain; retained for inspection');
    receipt = { route, binding, body, textDigest: digest, phase: 'calling', created: epoch(), announced: false,
      maintenance: { rings: 0, last: 0 } };
    writeJson(receiptFile, receipt);
    let output = '', succeeded = false;
    try {
      output = await this.run(path.join(this.codeRoot, 'bin/fm-inbox.sh'), ['note', '-'],
        { env: this.env, input: body });
      succeeded = true;
    } catch (error) { output = error.stdout ?? ''; }
    const saved = this.findNote(key, body);
    const publishedId = /^queued ([A-Za-z0-9._-]{1,200})$/m.exec(output)?.[1];
    if (!saved && !publishedId) {
      receipt.phase = 'uncertain'; writeJson(receiptFile, receipt);
      throw uncertain('note publication could not be proved; retained for inspection');
    }
    receipt.id = saved?.id ?? publishedId;
    receipt.phase = saved?.handled ? 'handled' : 'saved';
    receipt.announced = succeeded;
    writeJson(receiptFile, receipt);
    if (!succeeded && saved && !saved.handled) {
      await this.ring(saved.id);
      receipt.announced = true; writeJson(receiptFile, receipt);
    }
  }
  requestReceipt(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid transport message identity');
    const receipt = readJson(this.store.file(`handoffs/${key}.json`));
    const accepted = this.store.incoming(key) ?? readJson(this.store.file(`pending/${key}.json`));
    const current = this.store.currentRoute();
    if (!receipt || !['saved', 'handled'].includes(receipt.phase) || !safeId(receipt.id) ||
        (accepted && (accepted.operation !== 'note' || !sameRoute(accepted.route, receipt.route))) ||
        !sameRoute(receipt.route, current)) throw new Error('reply requires a published authenticated request on the current route');
    const binding = receipt.binding;
    if (binding?.home !== fs.realpathSync(this.home) || binding?.codeRoot !== path.resolve(this.codeRoot) ||
        binding?.state !== path.resolve(this.state)) throw new Error('request belongs to another Firstmate configuration');
    return { receipt, current };
  }
  reply(key, text) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid transport message identity');
    if (!validText(text)) throw new Error('invalid reply text');
    const { current } = this.requestReceipt(key);
    const request = this.requests.get(key);
    if (request?.state === 'failed') throw new Error('failed request cannot be completed');
    const queued = this.store.enqueue(text, { kind: 'reply', session: '', route: current, requestKey: key,
      id: `response:${key}:${sha256(text)}` });
    if (request && request.state !== 'completed') this.requests.transition(key, 'completed', text);
    return queued;
  }
  progress(key, state, text = '') {
    if (!REQUEST_STATES.includes(state) || ['received', 'completed'].includes(state)) throw new Error('use reply for final completion');
    const { current } = this.requestReceipt(key);
    const record = this.requests.transition(key, state, text);
    const label = text ? `${state}: ${text}` : state;
    this.store.enqueue(`Request ${key.slice(0, 12)} ${label}`, { kind: 'reply', session: '', route: current,
      requestKey: key, id: `progress:${key}:${record.updated}:${state}:${sha256(text)}` });
    return record;
  }
  watcherEvidence(now, staleAfter) {
    const beat = path.join(this.state, '.last-watcher-beat');
    try {
      const stat = fs.lstatSync(beat);
      if (!stat.isFile() || stat.isSymbolicLink()) return { code: 'watcher-unknown', text: 'controller has not acknowledged; watcher state unknown' };
      const age = Math.max(0, now - Math.floor(stat.mtimeMs / 1000));
      return age >= staleAfter
        ? { code: 'watcher-stale', text: `controller has not acknowledged; watcher beacon is ${age}s old` }
        : { code: 'unacknowledged', text: `controller has not acknowledged; watcher beacon is fresh (${age}s old)` };
    } catch (error) {
      if (error.code === 'ENOENT') return { code: 'watcher-unknown', text: 'controller has not acknowledged; watcher beacon is unavailable' };
      return { code: 'watcher-unknown', text: 'controller has not acknowledged; watcher state unknown' };
    }
  }
  async maintain({ now = epoch(), staleAfter = 300, maxRings = 3 } = {}) {
    const reports = [], current = this.store.currentRoute();
    for (const name of fs.readdirSync(this.store.file('handoffs')).filter(x => /^[a-f0-9]{64}\.json$/.test(x))) {
      const file = this.store.file(`handoffs/${name}`), receipt = readJson(file);
      if (!receipt?.id || !['saved', 'handled'].includes(receipt.phase) || !sameRoute(receipt.route, current)) continue;
      const found = this.findNote(name.slice(0, -5), receipt.body);
      if (found?.handled) {
        if (receipt.phase !== 'handled') { receipt.phase = 'handled'; writeJson(file, receipt); }
        const request = this.requests.get(name.slice(0, -5));
        if (request?.state === 'received') this.requests.transition(request.key, 'picked-up', 'Firstmate inbox recorded handling.');
        continue;
      }
      const maintenance = receipt.maintenance ?? { rings: 0, last: 0 };
      if (now - (receipt.created ?? now) < staleAfter || now - maintenance.last < staleAfter) continue;
      const requestKey = name.slice(0, -5);
      const markWaiting = evidence => {
        const request = this.requests.get(requestKey);
        if (request && request.state !== 'waiting' && !['completed', 'failed'].includes(request.state))
          this.requests.transition(requestKey, 'waiting', evidence);
      };
      const evidence = this.watcherEvidence(now, staleAfter);
      const report = (code, text) => ({ key: requestKey, state: 'waiting', evidence: text,
        code, dedupeId: `maintenance:${requestKey}:${code}`, text: `Request ${requestKey.slice(0, 12)} waiting: ${text}.` });
      if (maintenance.rings >= maxRings) { markWaiting(evidence.text); reports.push(report(evidence.code, evidence.text)); continue; }
      // Re-ring the exact existing inbox identity only. Never publish or execute the request again.
      try { await this.ring(receipt.id); maintenance.rings++; maintenance.last = now; receipt.maintenance = maintenance; writeJson(file, receipt);
        markWaiting(evidence.text); reports.push(report(evidence.code, evidence.text)); }
      catch { const text = 'wake failed; controller state unknown'; markWaiting(text); reports.push(report('wake-failed', text)); }
    }
    return reports;
  }
  notifyMaintenance(report) {
    if (!report || !/^[a-f0-9]{64}$/.test(report.key) || typeof report.dedupeId !== 'string' || !validText(report.text))
      throw new Error('invalid maintenance report');
    const { current } = this.requestReceipt(report.key);
    return this.store.enqueue(report.text, { kind: 'reply', session: '', route: current, requestKey: report.key,
      id: report.dedupeId });
  }
  async summary(command = 'status') {
    const route = { ...this.store.currentRoute(), provenance: 'whatsapp' };
    if (command === 'status') {
      const rows = this.requests.list(route), open = rows.filter(x => !['completed', 'failed'].includes(x.state));
      const text = `Remote request lifecycle: ${open.length} open, ${rows.length} recorded.\n` +
        `Firstmate recorded fleet status (separate from remote request lifecycle):\n${String(await this.status()).trim()}`;
      return this.requests.paginateText('status', route, text);
    }
    if (command === 'decisions') {
      const snapshot = await this.decisions();
      const text = snapshot.decisions.length ? snapshot.decisions.map(x => `${x.task}/${x.key}: ${x.text}`).join('\n') : 'No recorded open decisions.';
      return this.requests.paginateText('decisions', route, text);
    }
    return this.requests.summarize(command, route);
  }
  status() {
    return this.run(path.join(this.codeRoot, 'bin/fm-inbox.sh'), ['status'], { env: this.env });
  }
  async events() {
    return JSON.parse(await this.run(path.join(this.extensionRoot, 'bin/fm-whatsapp-events.sh'), ['--json'], { env: this.env }));
  }
  async decisions() {
    const value = JSON.parse(await this.run(path.join(this.extensionRoot, 'bin/fm-whatsapp-decisions.sh'), ['--json'], { env: this.env }));
    if (value?.schema !== 'fm-whatsapp-decisions.v1' || !Array.isArray(value.decisions)) throw new Error('invalid decision projection');
    return value;
  }
}
