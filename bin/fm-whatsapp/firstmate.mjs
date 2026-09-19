// Standalone adapter over existing Firstmate commands. Only those owners write
// Firstmate's inbox and wake queue; this adapter owns transport receipts elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { privateDirectory, readJson, writeJson, sha256 } from './core.mjs';

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
  }
  envelope(key, text) {
    return `[firstmate-whatsapp-message:${key}]\n` +
      'Remote note from the configured private WhatsApp chat. The captain remains away.\n' +
      `Load the external reply skill: ${path.join(this.extensionRoot, 'skills/whatsapp-delegate/SKILL.md')}\n` +
      `Reply configuration (JSON; pass values as environment data, never evaluate): ${JSON.stringify({ executable: path.join(this.extensionRoot, 'bin/fm-whatsapp.sh'), FM_HOME: this.home, FM_CODE_ROOT: this.codeRoot, FM_STATE_OVERRIDE: this.state, FM_DELEGATE_STATE: path.dirname(this.store.root) })}\n` +
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
    let receipt = readJson(receiptFile);
    // Persist the exact envelope once so relocating/upgrading the extension cannot
    // alter a previously published note during recovery.
    const digest = sha256(text);
    if (receipt && receipt.textDigest !== digest) throw new Error('transport message identity changed');
    const body = receipt?.body ?? this.envelope(key, text);
    const found = this.findNote(key, body);
    if (found) {
      receipt = { body, textDigest: digest, id: found.id, phase: found.handled ? 'handled' : 'saved',
        announced: receipt?.announced === true };
      writeJson(receiptFile, receipt);
      if (!found.handled && !receipt.announced) {
        await this.ring(found.id);
        receipt.announced = true; writeJson(receiptFile, receipt);
      }
      return;
    }
    if (receipt?.id) return; // A published note may have been retired; never recreate it.
    if (receipt) throw uncertain('previous note publication is uncertain; retained for inspection');
    receipt = { body, textDigest: digest, phase: 'calling', announced: false };
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
  status() {
    return this.run(path.join(this.codeRoot, 'bin/fm-inbox.sh'), ['status'], { env: this.env });
  }
  async events() {
    return JSON.parse(await this.run(path.join(this.extensionRoot, 'bin/fm-whatsapp-events.sh'), ['--json'], { env: this.env }));
  }
}
