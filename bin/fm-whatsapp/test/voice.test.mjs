import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, writeJson } from '../core.mjs';
import { loadVoiceConfig, transcribeVoice, VOICE_CONFIG_SCHEMA } from '../voice.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-voice-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home, path.join(home, 'state'));
  const bin = name => { const file = path.join(home, name); fs.writeFileSync(file, '#!/bin/false\n', { mode: 0o700 }); return file; };
  const ffmpeg = bin('ffmpeg'), whisper = bin('whisper-cli'), model = path.join(home, 'model.bin');
  fs.writeFileSync(model, 'fake model', { mode: 0o600 });
  const input = path.join(home, 'voice.ogg'); fs.writeFileSync(input, 'OggSvoice', { mode: 0o600 });
  return { home, store, ffmpeg, whisper, model, input };
}

test('voice config requires private absolute local executables and model', t => {
  const f = fixture(t);
  assert.equal(loadVoiceConfig(f.store).available, false);
  writeJson(f.store.file('voice.json'), { schema: VOICE_CONFIG_SCHEMA, ffmpeg: 'ffmpeg', whisper: f.whisper, model: f.model });
  assert.match(loadVoiceConfig(f.store).message, /invalid/);
  writeJson(f.store.file('voice.json'), { schema: VOICE_CONFIG_SCHEMA, ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en' });
  const config = loadVoiceConfig(f.store);
  assert.equal(config.available, true); assert.equal(config.language, 'en');
  const link = path.join(f.home, 'model-link'); fs.symlinkSync(f.model, link);
  writeJson(f.store.file('voice.json'), { schema: VOICE_CONFIG_SCHEMA, ffmpeg: f.ffmpeg, whisper: f.whisper, model: link });
  assert.equal(loadVoiceConfig(f.store).available, false);
});

test('fake offline subprocess receives argv arrays and transcript is returned', async t => {
  const f = fixture(t), calls = [];
  const config = { available: true, ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en' };
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === f.ffmpeg) fs.writeFileSync(args.at(-1), 'RIFF decoded wav');
    else {
      const prefix = args[args.indexOf('-of') + 1]; fs.writeFileSync(`${prefix}.txt`, 'turn the simulation off\n');
    }
    return { stdout: '', stderr: '' };
  };
  const result = await transcribeVoice(f.input, { store: f.store, config, run });
  assert.deepEqual(result, { available: true, text: 'turn the simulation off' });
  assert.equal(calls.length, 2); assert.ok(calls.every(call => Array.isArray(call.args)));
  assert.deepEqual(calls[0].args.slice(0, 3), ['-nostdin', '-hide_banner', '-loglevel']);
  assert.equal(calls[1].args[calls[1].args.indexOf('-m') + 1], f.model);
  assert.deepEqual(fs.readdirSync(f.store.file('voice-tmp')), []);
});

test('transcription failures are intelligible and always clean private temporaries', async t => {
  const f = fixture(t);
  const config = { available: true, ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en' };
  const failed = await transcribeVoice(f.input, { store: f.store, config,
    run: async (file, args) => { if (file === f.ffmpeg) fs.writeFileSync(args.at(-1), 'wav'); throw new Error('secret stderr'); } });
  assert.equal(failed.available, false); assert.match(failed.message, /failed locally/);
  assert.ok(!failed.message.includes('secret'));
  assert.deepEqual(fs.readdirSync(f.store.file('voice-tmp')), []);
  const absent = await transcribeVoice(f.input, { store: f.store, config: { available: false, message: 'Install offline tools.' } });
  assert.deepEqual(absent, { available: false, message: 'Install offline tools.' });
});

test('oversized, missing and control-character transcripts fail closed', async t => {
  const f = fixture(t);
  const config = { available: true, ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en' };
  for (const output of [null, '\u0000bad', 'x'.repeat(12001)]) {
    const result = await transcribeVoice(f.input, { store: f.store, config, run: async (file, args) => {
      if (file === f.ffmpeg) fs.writeFileSync(args.at(-1), 'wav');
      else if (output !== null) fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.txt`, output);
    } });
    assert.equal(result.available, false);
    assert.deepEqual(fs.readdirSync(f.store.file('voice-tmp')), []);
  }
});
