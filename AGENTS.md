# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Validation

`npm run check` and `npm test` at the repository root; README "Validation" is authoritative. Set `FM_TEST_CODE_ROOT` to an installed Firstmate to unskip the integration tier.

## Testing the bridge lifecycle

`bin/fm-whatsapp/cli.mjs` exports only small helpers; its `main()` self-starts when `process.argv[1]` is the cli path. To test the real `run` lifecycle (QR, reconnect, Telegram fallback), use `bin/fm-whatsapp/test/cli-lifecycle.test.mjs`, which spawns `test/cli-lifecycle-driver.mjs` under `node --experimental-test-module-mocks`: the driver registers `mock.module` fakes for `@whiskeysockets/baileys` and `qrcode-terminal`, sets `process.argv` before importing the cli, drives socket events on a timeline, and reports a `DRIVER_RESULT` JSON line through a synchronous stderr write in a process `exit` hook (the CLI calls `process.exit` itself, which truncates buffered stdout).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
