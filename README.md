# Firstmate WhatsApp extension

A standalone, private extension for talking to Firstmate while away through WhatsApp, using either **Message yourself** or one explicitly selected second number.
It adds no messaging API fees, paid gateway, or model calls.
It uses the free unofficial [Baileys linked-device client](https://baileys.wiki/).
The computer running Firstmate must stay online; existing agent and connectivity costs still apply.

Firstmate's repository stays unchanged.
The extension uses its installed inbox, AFK validator, status classifier, and wake library.
It does not copy Firstmate source or change its permissions, AFK schema, or supervisor ownership.
Telegram is a possible fallback, not a dependency of this WhatsApp setup; no BotFather account or token is needed.

## Install and pair

Requires Node 20 or newer, Bash, jq, and an installed Firstmate home.
From this repository:

```bash
npm run setup
export FM_HOME=/absolute/path/to/firstmate-home
# Only needed if Firstmate's scripts live somewhere other than FM_HOME:
export FM_CODE_ROOT="$FM_HOME"
./bin/fm-whatsapp.sh pair
```

On your phone, open **WhatsApp → Settings → Linked devices → Link a device** and scan the QR.
For a local image, use `pair --qr-file /absolute/private/path/pair.qr.svg`.
The image is removed after pairing or a clean stop.
Keep QR images private; do not upload them to a sharing site.

Start the bridge and leave it running:

```bash
./bin/fm-whatsapp.sh run
```

To use a second number, stop the bridge and run `./bin/fm-whatsapp.sh recipient +COUNTRYNUMBER` before starting it again.
Only that number's incoming private messages will be accepted; messages from other contacts and outbound echoes are ignored.
Use `recipient self` to restore Message yourself.
Recipient changes require empty inbound and outbound queues so pending messages cannot silently move to another person.
The phone number is stored only in private local state.
After startup, `./bin/fm-whatsapp.sh ping` sends a connection-test greeting to the selected chat.

In another terminal with the same environment, enable AFK notifications:

```bash
./bin/fm-whatsapp.sh enable
./bin/fm-whatsapp.sh status
```

Use Firstmate's ordinary AFK procedure to enter away mode.
The extension requires a confirmed AFK record before sending automatic questions or supervisor replies.
Its enablement is separate from Firstmate's stored `reach_channels: none` profile, which remains unchanged.
It observes subsequent confirmed AFK sessions until disabled.
Firstmate retains hold-for-return behavior whenever a response is unavailable.

## Talk from your phone

In the configured chat (Message yourself by default, or the chat with the linked account from your second number):

- `status` reads recorded fleet status without waking Firstmate.
- `Please check the failing simulation` saves a request and wakes the existing supervisor.
- `help` shows the command summary.
- Reply to a delivered Firstmate question to include its persisted context with your answer.

No prefix is required: ordinary text goes directly to Firstmate as a request.
Only the exact words `status` and `help` are local shortcuts, ignoring case and surrounding whitespace.
The older `!fm status`, `!fm help`, and `!fm note TEXT` forms remain accepted.

The supervisor must be running and handling its inbox to answer conversational requests.
Each note includes the path to this extension's [supervisor skill](skills/whatsapp-delegate/SKILL.md) and a reply command.
No installation into Firstmate's tracked skill directory is required.
Phone messages do not themselves end AFK mode or execute decisions.
The bridge's immediate “saved” receipt is distinct from Firstmate's eventual answer.

The supervisor sends answers using this repository's script, with text on stdin:

```bash
printf '%s\n' 'The simulation finished; the result meets the stated target.' |
  ./bin/fm-whatsapp.sh notify
```

Ordinary help/status/receipt replies work while the bridge is running, including outside AFK.
Automatic notices cover unresolved recorded `needs-decision` keys for tasks that still have metadata.
General progress is available through status and supervisor replies.

## Private state and lifecycle

Bridge credentials, queues, receipts, and settings live outside Firstmate under the per-home directory in `${XDG_STATE_HOME:-~/.local/state}/firstmate-whatsapp/`.
Set `FM_DELEGATE_STATE` to an absolute directory to select another private location.
`FM_STATE_OVERRIDE`, when used, selects Firstmate's state only.
The extension binds its state to one Firstmate home to prevent accidental reuse.
Directories are mode 700 and state files mode 600.
Never commit or share these files.

`disable` stops automatic AFK notification eligibility; stop `run` with Ctrl-C to stop all bridge traffic.
Stopping preserves the linked session; unlink it from the phone to revoke it.
The runtime can be supervised by an existing process manager using the same explicit environment.
Do not launch a second copy against the same state directory.
After an unclean shutdown, inspect a reported stale lock and confirm its process is gone before removing that lock directory.

Inbound messages are accepted only from the selected private chat.
Other contacts, groups, forwarded content, media, history, and arbitrary shell commands are ignored.
Accepted requests are journaled before handing off to Firstmate.
The adapter recovers already-published inbox notes instead of blindly submitting duplicates.
If the inbox helper was interrupted and publication cannot be proved, the request stays pending for operator inspection.
Its private `whatsapp/handoffs/` receipt preserves the exact envelope and publication phase.
Check both Firstmate's pending and handled inbox and ensure the old helper has exited before attempting recovery; do not delete the receipt and blindly retry a potentially delivered instruction.
Notifications wait for a matching server acknowledgement; this does not prove that a person read them.
A remote-send/local-receipt crash can duplicate an outbound message.
Offline queues retry, and questions from ended AFK sessions or resolved decisions expire.

## Validation

This repository uses local validation only; GitHub Actions is disabled and no CI workflow is installed.

```bash
npm run check
npm test
FM_TEST_CODE_ROOT=/absolute/path/to/unchanged/firstmate npm test
FM_TEST_CODE_ROOT=/absolute/path/to/unchanged/firstmate node --test test/*.test.mjs
```

Transport tests use fake sockets and temporary homes.
Integration tests use an installed Firstmate with temporary operational state and do not touch the real supervisor.
Live pairing and a real phone round trip remain separate acceptance checks.
WhatsApp can disconnect unofficial clients; if it cannot work for this account, a Telegram transport can be added to this independent repository.
