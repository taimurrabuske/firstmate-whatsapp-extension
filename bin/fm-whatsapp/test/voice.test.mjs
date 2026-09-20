import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, writeJson } from '../core.mjs';
import { loadVoiceConfig, transcribeVoice, validateVoicePaths, VOICE_CONFIG_SCHEMA, VOICE_LIMITS } from '../voice.mjs';

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

test('validateVoicePaths accepts only absolute regular local files and normalizes language', t => {
  const f = fixture(t);
  const resolved = validateVoicePaths({ ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model });
  assert.deepEqual(resolved, { ffmpeg: fs.realpathSync(f.ffmpeg), whisper: fs.realpathSync(f.whisper),
    model: fs.realpathSync(f.model), language: 'en' });
  assert.equal(validateVoicePaths({ ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'de' }).language, 'de');
  const link = path.join(f.home, 'linked-whisper'); fs.symlinkSync(f.whisper, link);
  for (const bad of [
    { ffmpeg: 'ffmpeg', whisper: f.whisper, model: f.model },
    { ffmpeg: f.ffmpeg, whisper: link, model: f.model },
    { ffmpeg: f.ffmpeg, whisper: f.whisper, model: path.join(f.home, 'absent.bin') },
    { ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'EN' },
    { ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en-us' }
  ]) assert.throws(() => validateVoicePaths(bad), /voice /);
  const noexec = path.join(f.home, 'noexec'); fs.writeFileSync(noexec, '#!/bin/false\n', { mode: 0o600 });
  assert.throws(() => validateVoicePaths({ ffmpeg: noexec, whisper: f.whisper, model: f.model }), /ffmpeg must be an absolute local regular executable/);
});

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

test('a full thirty-minute note is accepted with raised decode cap and runtime bounds', async t => {
  const f = fixture(t), calls = [];
  const config = { available: true, ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en' };
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === f.ffmpeg) {
      // Sparse file sized like a real full-length decode: 44-byte WAV header plus 16 kHz mono 16-bit PCM.
      const wav = args.at(-1);
      fs.writeFileSync(wav, 'RIFF');
      fs.truncateSync(wav, VOICE_LIMITS.maxSeconds * 32_000 + 44);
    } else {
      const prefix = args[args.indexOf('-of') + 1]; fs.writeFileSync(`${prefix}.txt`, 'thirty minute transcript\n');
    }
    return { stdout: '', stderr: '' };
  };
  const result = await transcribeVoice(f.input, { store: f.store, config, run });
  assert.deepEqual(result, { available: true, text: 'thirty minute transcript' });
  assert.equal(calls[0].args[calls[0].args.indexOf('-t') + 1], '1800');
  assert.equal(calls[0].options.timeout, VOICE_LIMITS.decodeTimeoutMs);
  assert.equal(calls[1].options.timeout, VOICE_LIMITS.transcribeTimeoutMs);
  assert.deepEqual(fs.readdirSync(f.store.file('voice-tmp')), []);
});

test('decoded audio beyond the thirty-minute bound fails closed and cleans temporaries', async t => {
  const f = fixture(t);
  const config = { available: true, ffmpeg: f.ffmpeg, whisper: f.whisper, model: f.model, language: 'en' };
  let whisperCalls = 0;
  const result = await transcribeVoice(f.input, { store: f.store, config, run: async (file, args) => {
    if (file === f.ffmpeg) {
      // Sparse file twice the size of a full-length decode: over any sane cap for the accepted duration.
      const wav = args.at(-1);
      fs.writeFileSync(wav, 'RIFF');
      fs.truncateSync(wav, VOICE_LIMITS.maxSeconds * 32_000 * 2);
    } else whisperCalls++;
    return { stdout: '', stderr: '' };
  } });
  assert.equal(result.available, false); assert.match(result.message, /failed locally/);
  assert.equal(whisperCalls, 0);
  assert.deepEqual(fs.readdirSync(f.store.file('voice-tmp')), []);
});
