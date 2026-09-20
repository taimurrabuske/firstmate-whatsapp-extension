# Media and offline voice integration

`bin/fm-whatsapp/media.mjs` is transport-neutral and does not import Baileys or fetch URLs. The bridge injects its authenticated Baileys downloader only after metadata filtering. `MediaIntake` journals each accepted encrypted locator before asynchronous download/transcription, so a restart retains the intake and duplicate delivery cannot create another note. A locator that fails three processing passes keeps its private record and queues one local failure notice instead of retrying silently.

## Exported API

- `stageAttachment(store, absoluteFile, { requestKey })` copies an image/PDF/text/CSV/JSON into the private store. `requestKey` must identify a published `saved`/`handled` handoff on the current authenticated route. Relative paths, symlinks, non-regular files, MIME/extension mismatches, and oversized files are rejected. The returned metadata is suitable for an `attachment` field on an outbound job.
- `outboundContent(job, store)` reopens, rehashes, and size-checks the staged copy and returns a Baileys `sendMessage` content object. Its `{url}` is always a verified local private-store path, never a remote URL.
- `authenticateMediaMetadata(message, identity, now, pairedAt, peer)` applies the existing direct-chat direction, account/LID alias, timestamp, and message-ID rules without downloading.
- `authenticatedMediaMessage(message, identity, now, pairedAt, peer, {store, download, transcribe})` authenticates and bounds metadata, calls `download(message, metadata)`, streams no more than the declared/allowed byte count into private storage, checks content magic, and returns safe surrogate text and attachment metadata. It returns `null` for rejected messages. The callback may return a `Buffer`, iterable, async iterable, or Node readable stream.

The caller should pass the accepted surrogate `text` through the ordinary durable pending/inbox path and retain the returned `key`; captions and quoted payloads are intentionally not treated as instructions. Groups, other senders, history/stale messages, forwarded media, view-once/wrapped messages, outbound echoes in second-number mode, and non-PTT audio are rejected before download. Current limits are 8 MiB images, 15 MiB documents, 10 MiB/thirty-minute voice, and 120-byte filenames.

Supported outgoing types are JPEG, PNG, WebP, PDF, plain text, CSV, and JSON. Incoming additionally accepts PTT Ogg/Opus, MP3, or MP4 voice notes. Baileys integration can inject its installed `downloadMediaMessage`/stream helper; no network locator from a message should be passed to `stageAttachment` or `outboundContent`.

## Offline voice configuration

`bin/fm-whatsapp/voice.mjs` exports `loadVoiceConfig(store)`, `transcribeVoice(input, options)`, `runProgram`, and `validateVoicePaths(paths)`. Configure it from the operator terminal without editing state by hand:

```bash
./bin/fm-whatsapp.sh voice-config set /absolute/path/to/ffmpeg /absolute/path/to/whisper-cli /absolute/private/path/to/ggml-model.bin [LANG]
./bin/fm-whatsapp.sh voice-config inspect
./bin/fm-whatsapp.sh voice-config remove
```

`set` validates every argument (absolute, regular, non-symlink; executables need an execute bit; language defaults to `en`) before atomically writing the private mode-600 `whatsapp/voice.json` under the state root. `inspect` prints the validated setup as JSON; `remove` clears it and is idempotent. Configuration changes apply to voice notes processed afterwards. Hand-written private `voice.json` files remain supported:

```json
{"schema":"fm-whatsapp-voice.v1","ffmpeg":"/absolute/path/to/ffmpeg","whisper":"/absolute/path/to/whisper-cli","model":"/absolute/private/path/to/ggml-model.bin","language":"en"}
```

All three paths must be absolute local regular files; executables must have an execute bit, and symlinks are rejected. Install `ffmpeg` and build the free `whisper.cpp` `whisper-cli` separately. Model downloads happen only through the explicit `voice-model install` command below, and no model API or paid gateway is used. Configuration is read only from private local state, not incoming text; the configured paths are operator arguments and are never echoed into phone chat, logs, or doctor output.

`transcribeVoice` invokes both programs with `execFile` argument arrays (no shell), decodes mono 16 kHz audio capped at thirty minutes, bounds each subprocess's runtime (five minutes for ffmpeg decode, thirty minutes for whisper.cpp) and captured output, bounds decoded WAV and transcript size, and removes its private temporary directory in `finally`. It returns `{available:true,text}` or an intelligible `{available:false,message}`; command stderr and local secrets are not exposed. The original bounded private voice attachment remains available when transcription fails.

The integrated bridge wiring:

```js
const accepted = await authenticatedMediaMessage(message, identity, now, pairedAt, peer, {
  store,
  download: msg => downloadMediaMessage(msg, 'stream', {}, downloadContext),
  transcribe: file => transcribeVoice(file, { store })
});
```

The caller remains responsible for durable deduplication before handoff, queueing the staged attachment with the authenticated reply route, and using its normal server-acknowledged send flow. Media acceptance does not change AFK state, approve work, or bypass Firstmate task/merge/spend gates.

Long voice transcripts remain in a private `.transcript.txt` file; when transcription succeeds, the inbox envelope presents the bounded preview explicitly as the user's authenticated instruction, with the full-transcript path first and delimited `Bounded transcript preview (start)`/`(end)` lines. The controller reads the full file. Failed transcription stays an explicit non-command result: the envelope carries only the failure message and the retained private attachment, never a transcript. Captions and media metadata are never treated as instructions. Use `voice-status` to inspect configuration. An installation can use a local English `base.en` model; no voice data is sent to a transcription service.

### Installing a model into this extension's private state

This extension downloads and owns its own whisper.cpp ggml models; nothing from another installed speech application is reused, attached to, or required. A download happens only when an operator explicitly asks for one specific model, never automatically and never during `run`, pairing, or transcription:

```bash
./bin/fm-whatsapp.sh voice-model list
./bin/fm-whatsapp.sh voice-model install base.en
./bin/fm-whatsapp.sh voice-config set /absolute/path/to/ffmpeg /absolute/path/to/whisper-cli base.en [LANG]
./bin/fm-whatsapp.sh voice-model remove base.en
```

`voice-model list` prints every supported model with its size, description, and installed state. The catalog keeps several models selectable; there is no single mandatory model, and operators choose the accuracy/memory trade-off themselves.

`voice-model install NAME` streams one model over HTTPS (only HTTPS; redirects are followed only to further HTTPS targets) into a bounded temporary file inside the extension's private `whatsapp/models/` state directory, checks the exact declared byte count and the pinned sha256 manifest, and installs the file atomically with mode 600. Failures and checksum mismatches remove the temporary and change nothing; a corrupted existing install is replaced only after the replacement verifies. Re-installing a verified model is a no-op that downloads nothing.

`voice-model remove NAME` deletes only that one model file from the private models directory. Removing a model that `voice.json` still references leaves the configuration in place but transcription fails closed until another model is selected; nothing is downloaded automatically.

`voice-config set` accepts either an absolute local model path (unchanged, and hand-written private `voice.json` files stay supported) or the name of an installed catalog model, and stores the resolved private absolute path. Selecting a not-yet-installed name fails with guidance; it never triggers a download.

Provenance: download URLs and the verification manifest follow the public whisper.cpp ggml model repository on Hugging Face (`ggerganov/whisper.cpp`) at the revision pinned in `bin/fm-whatsapp/model-store.mjs`. Each model's sha256 and byte size equal the LFS object header that repository publishes for the file at the pinned revision (verified against the Hugging Face API tree). The URL and manifest conventions were identified from the public upstream Vocalinux catalog (VocaHQ/vocalinux); no implementation code, runtime, state, or installed file from any other speech application is copied or reused. To refresh the catalog, verify new digests with the Hugging Face API at the new revision and update the pinned revision and digests together in one commit.
An installed Vocalinux dictation app keeps standard ggml Whisper weights on disk (for example `~/.local/share/vocalinux/models/whispercpp/ggml-*.bin`) and those regular files are directly usable as the `voice-config set` model path. Local evidence from the installed package: its whisper.cpp runtime is embedded as `libwhisper.so` plus the `pywhispercpp` CPython extension inside its private virtualenv, its main process owns no listening TCP or unix socket (the only `LISTEN` socket in the family is its ibus helper's private text-injection socket), and its only DBus use is a session-bus availability probe. It therefore exposes no stable local daemon/socket/API for submitting audio to its RAM-resident model, and no adapter is built against its internals. Reusing a model file still loads a separate copy per transcription process, so RAM is not shared with the running app. Never stop, restart, or reconfigure that app from this extension; its keep-alive, models, and settings remain operator-owned. The standalone whisper.cpp fallback remains fully supported.

## Quarantine and retention for attachment state

Attachment blobs are content-addressed and never modified in place. A record damaged after its atomic write (truncated bytes, wrong type, or an incompatible future schema) is moved byte-preserved under `whatsapp/quarantine/` with a `.meta.json` sidecar naming its origin and reason, and doctor reports the quarantine contents; nothing is ever deleted there automatically. Bounded retention (`bin/fm-whatsapp/retention.mjs`, run from the bridge tick) removes attachment blobs, metadata, and transcripts only after the 30-day horizon **and** only when no unresolved record still references them: staged attachments of undelivered queue entries are protected by digest, and any pending job, handoff envelope, or journaled request text protects the exact paths it names (including transcripts) regardless of age.
