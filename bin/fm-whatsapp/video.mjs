// Offline video inspection using argv-only ffmpeg and whisper.cpp calls.
// Reuses the same private voice.json configuration as voice transcription:
// ffmpeg probes and extracts representative keyframes, whisper.cpp transcribes
// the audio track. Nothing here uploads media anywhere or fetches URLs.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readJson } from './core.mjs';
import { loadVoiceConfig, runProgram, VOICE_LIMITS } from './voice.mjs';

export const VIDEO_CONFIG_SCHEMA = 'fm-whatsapp-video.v1';
export const VIDEO_LIMITS = Object.freeze({ frames: 3, maxDimension: 1280, maxFrameBytes: 4_000_000,
  probeTimeoutMs: 60_000, frameTimeoutMs: 120_000 });

function safeRegular(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}

/**
 * Parse the `ffmpeg -i` banner into bounded media facts. Pure function of the
 * captured stderr, so every branch below is testable without a binary.
 */
export function parseFfmpegMediaInfo(stderr) {
  const text = typeof stderr === 'string' ? stderr : '';
  if (!text) return null;
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(text);
  const video = /Stream #\d+:\d+(?:\[[^\]]*\])?\(?.*\)?:\s*Video:\s*([^\s,]+)/.exec(text);
  if (!duration || !video) return null;
  const durationSeconds = Math.min(Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) + Number(`0.${duration[4]}`),
    VOICE_LIMITS.maxSeconds);
  const dimensions = /(\d{2,5})x(\d{2,5})/.exec(text.slice(text.indexOf(video[0])));
  const width = dimensions ? Math.min(Number(dimensions[1]), 100_000) : 0;
  const height = dimensions ? Math.min(Number(dimensions[2]), 100_000) : 0;
  return { durationSeconds, width, height, codec: video[1], hasAudio: /Stream #\d+:\d+(?:\[[^\]]*\])?\(?.*\)?:\s*Audio:/.test(text) };
}

/** Interior, deduplicated sampling timestamps: the middle of each equal span. */
export function frameTimestamps(durationSeconds, count) {
  const total = Number(durationSeconds);
  if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count < 1) return [0];
  const points = [];
  for (let index = 0; index < count; index++) points.push(total * (index + 0.5) / count);
  return [...new Set(points.map(value => Math.min(Math.max(Math.round(value * 100) / 100, 0), Math.max(total - 0.01, 0))))].sort((a, b) => a - b);
}

// ffmpeg with `-i` and no output target exits nonzero after printing the media
// banner; probe treats that exit as data rather than failure.
function inspectProgram(file, args, { timeout = 60_000 } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && error.killed) return resolve(null); // bounded runtime exceeded: no facts
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** Probe one local media file with the configured ffmpeg. Returns bounded facts or null. */
export async function probeVideoMedia(input, { ffmpeg, run = inspectProgram, timeoutMs = VIDEO_LIMITS.probeTimeoutMs } = {}) {
  if (!safeRegular(input) || typeof ffmpeg !== 'string') return null;
  const result = await run(ffmpeg, ['-nostdin', '-hide_banner', '-i', input], { timeout: timeoutMs });
  return result ? parseFfmpegMediaInfo(result.stderr) : null;
}

const scaleFilter = max => `scale=min(${max}\\,iw):min(${max}\\,ih):force_original_aspect_ratio=decrease`;

/**
 * Extract one still per requested timestamp into the caller's pre-verified
 * private target paths. A failed seek falls back to the first frame; a frame
 * that still cannot be produced is simply absent from the result.
 */
export async function extractVideoFrames(input, targets, timestamps, { ffmpeg, run = runProgram,
  timeoutMs = VIDEO_LIMITS.frameTimeoutMs, maxDimension = VIDEO_LIMITS.maxDimension } = {}) {
  const frames = [];
  if (!safeRegular(input) || typeof ffmpeg !== 'string') return frames;
  for (const [index, target] of (targets ?? []).entries()) {
    const at = timestamps?.[index] ?? 0;
    for (const seek of at > 0 ? [['-ss', String(at)], []] : [[]]) {
      try {
        await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...seek, '-i', input,
          '-frames:v', '1', '-vf', scaleFilter(maxDimension), '-q:v', '3', target],
          { timeout: timeoutMs, maxBuffer: 128 * 1024 });
      } catch { continue; }
      if (safeRegular(target)) {
        const bytes = fs.statSync(target).size;
        if (bytes >= 1 && bytes <= VIDEO_LIMITS.maxFrameBytes) frames.push({ path: target, at: seek.length ? at : 0, bytes });
        break;
      }
    }
  }
  return frames;
}

const NO_AUDIO = 'The video has no audio track, so there is nothing to transcribe.';

/**
 * Inspect one staged video attachment: probe facts, extract representative
 * keyframes beside it in the private incoming bucket, and transcribe the audio
 * track when present. Every dependency is injectable for tests; defaults use
 * the private voice.json ffmpeg/whisper configuration. The result always
 * resolves with intelligible facts; it never throws and never stages anything
 * outside the given store.
 */
export async function describeVideoMedia(store, attachment, { probe, extractFrames, transcribe, run } = {}) {
  // The private ffmpeg/whisper configuration gates only the default hooks;
  // a caller supplying its own probe/extract hooks owns that dependency.
  const setup = !probe || !extractFrames ? loadVoiceConfig(store) : { available: true, ffmpeg: null };
  if (!setup?.available) return { available: false,
    message: 'Video inspection is unavailable; configure private offline ffmpeg and whisper.cpp paths (see docs/media.md).' };
  const input = attachment?.path;
  const info = await (probe ?? probeVideoMedia)(input, { ffmpeg: setup.ffmpeg, ...(run ? { run } : {}) });
  if (!info || !(info.durationSeconds >= 0)) {
    return { available: false, message: 'Video inspection failed locally (the clip may be corrupt or in an unsupported container); the saved attachment remains available.' };
  }
  const digest = typeof attachment?.digest === 'string' ? attachment.digest : null;
  const bucket = digest ? store.file('attachments/incoming') : null;
  const targets = bucket ? Array.from({ length: VIDEO_LIMITS.frames },
    (_, index) => `${bucket}/${digest}.frame-${index + 1}.jpg`) : [];
  const frames = await (extractFrames ?? extractVideoFrames)(input, targets, frameTimestamps(info.durationSeconds, targets.length),
    { ffmpeg: setup.ffmpeg, ...(run ? { run } : {}) });
  let transcript;
  if (!info.hasAudio) transcript = { available: false, audioTrack: false, message: NO_AUDIO };
  else {
    const result = typeof transcribe === 'function' ? await transcribe(input) :
      { available: false, message: 'Audio transcription is unavailable; no local whisper.cpp transcriber is configured.' };
    transcript = result?.available
      ? { available: true, text: result.text }
      : { available: false, audioTrack: true, message: result?.message || 'Audio transcription returned no usable text.' };
  }
  return { available: true, info, frames, transcript };
}

/** Read back a previously written probe sidecar, or null. */
export function readVideoSidecar(file) {
  try { const record = readJson(file); return record?.schema === VIDEO_CONFIG_SCHEMA ? record : null; }
  catch { return null; }
}
