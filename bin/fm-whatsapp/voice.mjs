// Offline voice-note transcription using argv-only ffmpeg and whisper.cpp calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { privateDirectory, readJson } from './core.mjs';

export const VOICE_CONFIG_SCHEMA = 'fm-whatsapp-voice.v1';
const MAX_TRANSCRIPT = 12_000;

function safeRegular(file, executable = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (executable && (stat.mode & 0o111) === 0) return false;
    return true;
  } catch { return false; }
}

/** Read whatsapp/voice.json. Config is private state, never environment or message text. */
export function loadVoiceConfig(store) {
  const file = store.file('voice.json');
  let config;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('unsafe voice config');
    config = readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, message: 'Voice transcription is unavailable; create private whatsapp/voice.json (see docs/media.md).' };
    return { available: false, message: 'Voice transcription setup is invalid; voice.json must be a private mode-600 regular file.' };
  }
  if (config.schema !== VOICE_CONFIG_SCHEMA || !safeRegular(config.ffmpeg, true) || !safeRegular(config.whisper, true) ||
      !safeRegular(config.model, false)) {
    return { available: false, message: 'Voice transcription setup is invalid; check absolute ffmpeg, whisper.cpp, and model paths.' };
  }
  return { available: true, ffmpeg: fs.realpathSync(config.ffmpeg), whisper: fs.realpathSync(config.whisper),
    model: fs.realpathSync(config.model), language: typeof config.language === 'string' && /^[a-z]{2,8}$/.test(config.language) ? config.language : 'en' };
}

export function runProgram(file, args, { timeout = 60_000, maxBuffer = 128 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error('offline transcription command failed'));
      else resolve({ stdout, stderr });
    });
  });
}

/** Always resolves with an intelligible result. Temporary audio/transcripts are removed on every path. */
export async function transcribeVoice(input, { store, config, run = runProgram, timeoutMs = 60_000 } = {}) {
  const setup = config ?? (store ? loadVoiceConfig(store) : null);
  if (!setup?.available) return { available: false, message: setup?.message || 'Voice transcription is unavailable; offline runtime is not configured.' };
  if (!safeRegular(input)) return { available: false, message: 'Voice transcription failed: the saved voice note is unavailable.' };
  const base = store?.file('voice-tmp') ?? path.join(path.dirname(input), '.voice-tmp');
  privateDirectory(base);
  const work = path.join(base, crypto.randomUUID());
  fs.mkdirSync(work, { mode: 0o700 });
  const wav = path.join(work, 'audio.wav'), output = path.join(work, 'transcript');
  try {
    await run(setup.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000',
      '-t', '300', '-f', 'wav', wav], { timeout: Math.min(timeoutMs, 60_000), maxBuffer: 128 * 1024 });
    if (!safeRegular(wav) || fs.statSync(wav).size > 20 * 1024 * 1024) throw new Error('invalid decoded audio');
    await run(setup.whisper, ['-m', setup.model, '-f', wav, '-l', setup.language, '-otxt', '-of', output, '--no-prints'],
      { timeout: Math.min(timeoutMs, 180_000), maxBuffer: 128 * 1024 });
    const transcript = `${output}.txt`;
    if (!safeRegular(transcript)) throw new Error('missing transcript');
    const stat = fs.statSync(transcript);
    if (stat.size < 1 || stat.size > MAX_TRANSCRIPT * 4) throw new Error('invalid transcript');
    const text = fs.readFileSync(transcript, 'utf8').trim();
    if (!text || text.length > MAX_TRANSCRIPT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('invalid transcript');
    return { available: true, text };
  } catch {
    return { available: false, message: 'Voice transcription failed locally; the saved voice note remains available for inspection.' };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
