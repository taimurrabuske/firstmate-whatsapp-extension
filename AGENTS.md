# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Validation

`npm run check` and `npm test` at the repository root; README "Validation" is authoritative. Set `FM_TEST_CODE_ROOT` to an installed Firstmate to unskip the integration tier.

## Testing the bridge lifecycle

`bin/fm-whatsapp/cli.mjs` exports only small helpers; its `main()` self-starts when `process.argv[1]` is the cli path. To test the real `run` lifecycle (QR, reconnect, Telegram fallback), use `bin/fm-whatsapp/test/cli-lifecycle.test.mjs`, which spawns `test/cli-lifecycle-driver.mjs` under `node --experimental-test-module-mocks`: the driver registers `mock.module` fakes for `@whiskeysockets/baileys` and `qrcode-terminal`, sets `process.argv` before importing the cli, drives socket events on a timeline, and reports a `DRIVER_RESULT` JSON line through a synchronous stderr write in a process `exit` hook (the CLI calls `process.exit` itself, which truncates buffered stdout).

## Size boundaries and delivery ordering

Transport sizing and ordering primitives live in `bin/fm-whatsapp/core.mjs`: `chunkText`/`truncateText`/`safeBoundaryEnd` are the only sanctioned way to cut text at a size boundary (never split surrogate pairs or CRLF, lossless by construction), and outbox delivery order is the durable `seq` stamped under the queue lock, read via `outboundOrder` — never outbox filename (hash) order. Multi-part replies share a `part.family`; a waiting part holds later parts in both `Bridge.flush` and the Telegram fallback. `requests.mjs` imports from `core.mjs` while `core.mjs` imports `RequestJournal`, so module-load-time use of core constants in `requests.mjs` must stay lazy (TDZ).

## Outbound delivery journal invariants

Crash-window and retry tests live in `bin/fm-whatsapp/test/outbound-delivery.test.mjs`; the journal contract they enforce is documented in `docs/delivery.md`. Sharp edges: crash windows are reproduced by restoring the exact durable files a crash leaves (outbox entry, sent receipt) and running a fresh `Bridge`/`TelegramDelegate`, not by hooking writes; `enqueue` regenerates a random `remoteId` when it creates an entry, so restoring the captured job object is the only way to preserve retry identity across a simulated crash; the Telegram fallback outage gate measures from the last tick that observed WhatsApp connected, so a fallback-path test must tick `connected: true` once before advancing the clock.

## Voice model catalog

`bin/fm-whatsapp/model-store.mjs` pins the supported whisper.cpp ggml catalog: Hugging Face `ggerganov/whisper.cpp` at a pinned revision, with per-file sha256 equal to the upstream LFS oid (see docs/media.md "Installing a model"). Refresh by re-verifying digests via the Hugging Face API at the new revision and updating revision and digests in one commit. Downloads are explicit operator commands only; model tests inject `fetchImpl` and must never touch the network.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
