// Private whisper.cpp model selection and installation for this extension.
// Nothing here touches any other application's runtime, state, or installed
// files: models are fetched over HTTPS into this extension's own private state
// only, and always by an explicit operator command.
//
// Catalog provenance: download URLs follow the public whisper.cpp ggml model
// repository on Hugging Face (ggerganov/whisper.cpp). The revision is pinned
// instead of tracking main. Each sha256 and byte size equals the upstream LFS
// object header that repository publishes for the file at the pinned revision
// (verified against the Hugging Face API tree for that revision). The URL and
// manifest conventions were identified from the public upstream Vocalinux
// catalog (VocaHQ/vocalinux); no implementation code is copied from it. To
// refresh the catalog, verify new digests against the Hugging Face API at the
// new revision and update WHISPERCPP_REVISION and WHISPER_MODEL_CATALOG
// together in one commit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { privateDirectory } from './core.mjs';

export const WHISPERCPP_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const WHISPERCPP_REPO = 'https://huggingface.co/ggerganov/whisper.cpp/resolve';

const CATALOG = Object.freeze({
  'tiny.en': { file: 'ggml-tiny.en.bin', sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f', bytes: 77_704_715, description: 'English-only tiny model; fastest, lowest accuracy' },
  'tiny': { file: 'ggml-tiny.bin', sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', bytes: 77_691_713, description: 'Multilingual tiny model; fastest, lowest accuracy' },
  'base.en': { file: 'ggml-base.en.bin', sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', bytes: 147_964_211, description: 'English-only base model; fast with usable accuracy' },
  'base': { file: 'ggml-base.bin', sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', bytes: 147_951_465, description: 'Multilingual base model; fast with usable accuracy' },
  'small.en': { file: 'ggml-small.en.bin', sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', bytes: 487_614_201, description: 'English-only small model; balanced speed and accuracy' },
  'small': { file: 'ggml-small.bin', sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', bytes: 487_601_967, description: 'Multilingual small model; balanced speed and accuracy' },
  'medium.en': { file: 'ggml-medium.en.bin', sha256: 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356', bytes: 1_533_774_781, description: 'English-only medium model; higher accuracy, slower' },
  'medium': { file: 'ggml-medium.bin', sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208', bytes: 1_533_763_059, description: 'Multilingual medium model; higher accuracy, slower' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69', bytes: 1_624_555_275, description: 'Large v3 turbo model; high accuracy with lower memory' },
  'large-v3': { file: 'ggml-large-v3.bin', sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2', bytes: 3_095_033_483, description: 'Large v3 model; highest accuracy, slowest' },
});
export const WHISPER_MODEL_CATALOG = CATALOG;
export const MODEL_LIMITS = Object.freeze({ maxRedirects: 5, downloadTimeoutMs: 3_600_000 });

const isCatalogName = name => typeof name === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, name);

export function modelsDirectory(store) {
  const directory = store.file('models');
  privateDirectory(directory);
  return directory;
}

/** Build the pinned upstream HTTPS URL for a catalog model. */
export function whisperModelUrl(name) {
  if (!isCatalogName(name)) throw new Error('voice model must be a supported catalog model; use voice-model list');
  return `${WHISPERCPP_REPO}/${WHISPERCPP_REVISION}/${CATALOG[name].file}`;
}

/** Installed absolute path for a catalog model inside the extension's private state. */
export function modelFile(store, name) {
  if (!isCatalogName(name)) return null;
  return path.join(store.file('models'), CATALOG[name].file);
}

function safeRegularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}

/** List the whole catalog with installed flags; never inspects non-catalog files. */
export function catalogModels(store) {
  return Object.entries(CATALOG).map(([name, entry]) => ({
    name, file: entry.file, bytes: entry.bytes, description: entry.description,
    installed: Boolean(store) && safeRegularFile(modelFile(store, name)),
    path: store ? modelFile(store, name) : null,
  }));
}

/** Resolve an installed catalog model name to its absolute private path, or null. */
export function resolveCatalogModel(store, name) {
  const file = modelFile(store, name);
  return file && safeRegularFile(file) ? file : null;
}

async function streamingDigest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function openHttpsBody(url, { fetchImpl, timeoutMs }) {
  let current = url;
  for (let hops = 0; hops <= MODEL_LIMITS.maxRedirects; hops++) {
    const target = new URL(current);
    if (target.protocol !== 'https:') throw new Error('model download refused: only HTTPS URLs are allowed');
    let response;
    try { response = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new Error('model download failed: network unreachable or interrupted'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      try { await response.body?.cancel(); } catch { }
      const location = response.headers?.get?.('location');
      if (!location) throw new Error('model download failed: redirect without a location');
      current = new URL(location, target).toString();
      continue;
    }
    if (!response.ok) throw new Error(`model download failed: upstream answered HTTP ${response.status}`);
    if (!response.body) throw new Error('model download failed: upstream returned no byte stream');
    return response.body;
  }
  throw new Error('model download failed: too many redirects');
}

/**
 * Explicitly download one supported model into the extension's private state.
 * Streams to a bounded temporary file in the same directory, verifies the exact
 * declared byte count and pinned sha256, then installs atomically with private
 * permissions. Every failure path removes the temporary. Re-installing a
 * verified model is a no-op; a corrupted or truncated install is replaced.
 */
export async function installWhisperModel(name, { store, fetchImpl = fetch, timeoutMs = MODEL_LIMITS.downloadTimeoutMs, catalog = CATALOG } = {}) {
  if (!store) throw new Error('model installation requires the private state store');
  const entry = catalog?.[name];
  if (!entry) throw new Error('voice model must be a supported catalog model; use voice-model list');
  const directory = modelsDirectory(store);
  const target = path.join(directory, entry.file);
  if (safeRegularFile(target)) {
    const digest = await streamingDigest(target);
    if (digest === entry.sha256) return { name, file: target, bytes: entry.bytes, sha256: digest, alreadyInstalled: true };
  }
  const temporary = path.join(directory, `.${entry.file}.${crypto.randomUUID()}.part`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    const body = await openHttpsBody(`${WHISPERCPP_REPO}/${WHISPERCPP_REVISION}/${entry.file}`, { fetchImpl, timeoutMs });
    const hash = crypto.createHash('sha256');
    let written = 0;
    for await (const chunk of Readable.fromWeb(body)) {
      written += chunk.length;
      // The declared upstream size bounds the temporary file; refuse anything past it.
      if (written > entry.bytes) throw new Error('model download failed: response exceeded the declared model size');
      hash.update(chunk);
      if (fs.writeSync(fd, chunk, 0, chunk.length) !== chunk.length) throw new Error('model download failed: write interrupted');
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    if (written !== entry.bytes) throw new Error('model download failed: response was shorter than the declared model size');
    if (hash.digest('hex') !== entry.sha256) throw new Error('model download failed: checksum did not match the pinned manifest; nothing was installed');
    // Verify-then-rename keeps the private permission bits and atomicity: the
    // final name only ever refers to a fully checksum-verified file.
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  } catch (error) {
    if (fd != null) { try { fs.closeSync(fd); } catch { } }
    fs.rmSync(temporary, { force: true });
    // Precise messages above stay intact; vendor, filesystem, and stream errors
    // are wrapped so local paths and exception text are never rendered.
    throw error instanceof Error && error.message.startsWith('model download')
      ? error : new Error('model download failed: network unreachable or interrupted');
  }
  const directoryFd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  return { name, file: target, bytes: entry.bytes, sha256: entry.sha256, alreadyInstalled: false };
}

/** Remove an installed catalog model. Never touches anything outside the private models directory. */
export function removeWhisperModel(name, { store } = {}) {
  if (!isCatalogName(name)) throw new Error('voice model must be a supported catalog model; use voice-model list');
  const file = modelFile(store, name);
  if (!safeRegularFile(file)) return { name, removed: false };
  fs.unlinkSync(file);
  return { name, removed: true };
}
