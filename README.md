# Firstmate WhatsApp extension

A standalone, private extension for talking to Firstmate while away through WhatsApp, using either **Message yourself** or one explicitly selected second number.
It adds no messaging API fees, paid gateway, or model calls.
It uses the free unofficial [Baileys linked-device client](https://baileys.wiki/).
The computer running Firstmate must stay online; existing agent and connectivity costs still apply.

Firstmate's repository stays unchanged.
The extension uses its installed inbox, AFK validator, status classifier, and wake library.
It does not copy Firstmate source or change its permissions, AFK schema, or supervisor ownership.
Telegram fallback is implemented but optional and inactive until explicitly paired. WhatsApp needs no Telegram account or bot token.

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
The extension requires a confirmed AFK record before sending automatic questions and other proactive alerts.
Responses to an accepted phone request work with or without AFK mode.
Its enablement is separate from Firstmate's stored `reach_channels: none` profile, which remains unchanged.
It observes subsequent confirmed AFK sessions until disabled.
Firstmate retains hold-for-return behavior whenever a response is unavailable.

## Talk from your phone

In the configured chat (Message yourself by default, or the chat with the linked account from your second number):

- `status` reads recorded fleet status without waking Firstmate.
- `pending`, `blocked`, and `last result` show this chat's recorded remote requests, progress, and outcomes.
- `decisions` reads currently open Firstmate decisions, including outside AFK.
- `more` continues the previous long summary.
- `Please check the failing simulation` saves a request and wakes the existing supervisor.
- `help` shows the command summary.
- Reply to a delivered Firstmate question to include its persisted context with your answer.

No prefix is required: ordinary text goes directly to Firstmate as a request.
These exact summary commands and the notification preferences below are local shortcuts, ignoring case and surrounding whitespace.
The older `!fm status`, `!fm help`, and `!fm note TEXT` forms remain accepted.
You can read the same recorded summaries from the operator terminal with `./bin/fm-whatsapp.sh summary <shortcut>` (for example `summary pending` or `summary last result`), using the same environment as the bridge.

The supervisor must be running and handling its inbox to answer conversational requests.
Each note includes the path to this extension's [supervisor skill](skills/whatsapp-delegate/SKILL.md) and a reply command.
No installation into Firstmate's tracked skill directory is required.
Phone messages do not themselves end AFK mode or execute decisions.
The bridge's immediate “saved” receipt is distinct from Firstmate's eventual answer.
Each request carries a durable ID and an explicit `received`, `picked-up`, `working`, `waiting`, `completed`, or `failed` state. Recent requests and answers supply bounded context to unquoted followups on the same authenticated route. Only the controller's explicit final reply records completion. An unanswered request can re-ring its existing wake up to three times; it never creates a second request or takes controller ownership. See [request lifecycle](docs/requests.md).

Send a screenshot, a supported document, or a voice note from the same allowed chat. Voice transcription runs locally using ffmpeg and whisper.cpp when [configured](docs/media.md); `./bin/fm-whatsapp.sh voice-config set FFMPEG WHISPER MODEL [LANGUAGE]` validates absolute local paths and writes the private configuration, with `voice-config inspect` and `voice-config remove` to read or clear it. Models are never downloaded. Media is privately staged before handoff; limits are 8 MiB for images, 15 MiB for documents, and 10 MiB / thirty minutes for voice. A successfully transcribed voice note is delivered as the instruction itself (the private transcript, with a bounded preview in the note), so no separate caption is needed. Captions and media metadata are never executed as commands; failed transcription is reported as an explicit non-command result. Forwarded, view-once, and wrapped media are refused.

## Notifications

Completions, failures, and open decisions can alert during confirmed AFK sessions. Progress alerts default off. Preferences persist locally:

```text
alerts
alerts progress on
unsubscribe project PROJECT
subscribe task TASK
quiet 22:00-08:00 America/New_York
digest 15
```

Task preferences override project preferences; unspecified tasks/projects remain subscribed. Use `alerts off`, `quiet off`, or `digest 0` to disable each feature.
Any of these commands also works from the operator terminal: `./bin/fm-whatsapp.sh preferences alerts progress on`. Decisions bypass the digest timer by default, but still respect quiet hours; `alerts decisions urgent off` delays them too. Decisions always arrive separately so quoting one identifies its exact task/key. Long digests retain complete events across multiple messages. Returning from AFK expires its unsent proactive alerts. Direct request replies remain available. [Notification details](docs/notifications.md).

## Connect the controlling Firstmate

Saving an inbox note alone does not reliably wake an idle Firstmate.
Install this repository's small `whatsapp-inbox` process-event package once per home so its existing watcher surfaces saved phone requests to the active controller.
The package uses Firstmate's supported external binding interface and leaves its source repository unchanged.
The controller must remain running with its ordinary watcher healthy.

First prepare a private copy **outside every Git checkout and outside Firstmate's home**.
Set `FM_DELEGATE_STATE` to the same absolute per-home state directory used by the bridge, and `FM_HOME`/`FM_CODE_ROOT` as above.
From this extension's checkout:

```bash
export WHATSAPP_EXTENSION_ROOT="$PWD"
export WHATSAPP_ADAPTER_STAGE="$HOME/.local/share/firstmate-whatsapp/inbox-adapter-1.0.0"
export WHATSAPP_ADAPTER_CONFIG="$FM_DELEGATE_STATE/inbox-adapter.json"
mkdir -p "$WHATSAPP_ADAPTER_STAGE/bin"
cp adapter/firstmate-extension.json "$WHATSAPP_ADAPTER_STAGE/"
cp adapter/bin/firstmate-extension.mjs "$WHATSAPP_ADAPTER_STAGE/bin/"
chmod 755 "$WHATSAPP_ADAPTER_STAGE" "$WHATSAPP_ADAPTER_STAGE/bin" "$WHATSAPP_ADAPTER_STAGE/bin/firstmate-extension.mjs"
chmod 644 "$WHATSAPP_ADAPTER_STAGE/firstmate-extension.json"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const env = process.env;
const config = {
  schema: 'firstmate.whatsapp-inbox-config.v1',
  source_id: 'whatsapp-inbox-main',
  whatsapp_state: fs.realpathSync(path.join(env.FM_DELEGATE_STATE, 'whatsapp')),
  fm_home: fs.realpathSync(env.FM_HOME),
  fm_state: fs.realpathSync(env.FM_STATE_OVERRIDE || path.join(env.FM_HOME, 'state')),
  extension_root: fs.realpathSync(env.WHATSAPP_EXTENSION_ROOT),
  poll_ms: 30000
};
fs.writeFileSync(env.WHATSAPP_ADAPTER_CONFIG, JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' });
NODE
```

The active Firstmate owner loads its `process-event-sources` skill, then binds and registers this explicitly trusted same-user package:

```bash
"$FM_CODE_ROOT/bin/fm-extension.sh" bind "$WHATSAPP_ADAPTER_STAGE" \
  --adapter whatsapp-inbox --trust-same-user-code --consent task-metadata --timeout-ms 45000
"$FM_CODE_ROOT/bin/fm-procevent.sh" register-extension whatsapp-inbox whatsapp-inbox-main \
  --config-ref "$WHATSAPP_ADAPTER_CONFIG"
"$FM_CODE_ROOT/bin/fm-procevent.sh" reconcile
"$FM_CODE_ROOT/bin/fm-procevent.sh" list
```

Confirm the source is reported `live`; a registration alone does not prove a runner is listening.
Preserve the exact token-bound retirement command printed during registration if the source must later be removed.
Do not run the polling entrypoint or `fm-procevent.sh start` in a conversational turn.
Package upgrades require owner-matched source and binding retirement after handling existing captured results; replacing the staged files does not alter an installed binding.

Events reference the existing pending inbox notes and the external reply skill, without copying phone text into the wake.
Only Firstmate decides how to handle the requests and acknowledges its notes and captured results.
The adapter retains the exact result across retries before capture, then checks durable capture before advancing its cursor; empty polls rescan under the same request identity.
Handled inbox notes are skipped even if their transport receipt still says `saved`.
The cursor is derivable state: a changed configuration binding or corrupt cursor bytes reset to a fresh cursor and rescan every still-saved note, while an unknown cursor schema or invalid cursor contents fail closed for operator inspection.
Changing `poll_ms` alone does not reset the cursor, and handled-note suppression entries are pruned so the seen set stays bounded.
The source polls for at most 30 seconds per invocation and stays registered between requests.
It reads local task metadata and requires no network or credential access; it never changes AFK mode.
This closes the missing wake path, but does not promise exactly-once actions or delivery if local durable state is lost.

## Reply from Firstmate

The supervisor uses the exact message key and environment in the received envelope, with its answer on stdin:

```bash
printf '%s\n' 'The simulation finished; the result meets the stated target.' |
  ./bin/fm-whatsapp.sh reply "$MESSAGE_KEY"
```

`reply` requires a published authenticated request on the current account, recipient, and Firstmate configuration.
It refuses unknown message keys, uncertain handoffs, and route changes.
Identical responses to the same request are deduplicated. For acknowledgement and progress, use `progress MESSAGE_KEY picked-up|working|waiting|failed` with detail on stdin. Use `reply` for the successful final result. Use `reply-file MESSAGE_KEY /absolute/report.pdf` to attach a requested report or plot, followed by the final text reply.
Use `notify` for proactive messages during confirmed AFK sessions.
A result longer than one transport message is split deterministically into ordered, size-bounded parts on whole-character (never surrogate-pair or CRLF) boundaries; each part keeps a stable identity, so retries never duplicate, skip, or reorder a piece, and identical replays still deduplicate.

Ordinary help/status/receipt replies work while the bridge is running, including outside AFK.
Automatic notices cover current decisions and new completion/failure/progress records for tasks that still have local metadata. The first observation of an AFK session suppresses historical outcomes. Fleet status and remote request lifecycle are separate views.

## Optional Telegram fallback

WhatsApp remains the primary transport. Telegram makes no network requests until configured. If needed, create a bot through Telegram's official @BotFather, store its token in an absolute, owner-only mode-600 local file, and obtain your exact numeric Telegram user ID through a trusted local account/session. Stop the bridge, finish queued work, and run:

```bash
./bin/fm-whatsapp.sh telegram-config /absolute/private/bot-token TELEGRAM_USER_ID
./bin/fm-whatsapp.sh run
```

Start a private conversation with your bot from that user. Only that exact user/private chat is accepted; groups, forwarded messages, and other users are ignored. The token never belongs in chat, command arguments, Git, or logs. Telegram accepts text requests and the same summaries/preferences, and can return text or requested report files. Incoming voice/media currently use WhatsApp.

After a two-minute WhatsApp outage, newly queued responses with an explicitly bound Telegram fallback may be delivered there. Older unbound messages are held on their original route. Pairing or token changes cannot redirect old replies to a new recipient. Telegram continues running when WhatsApp requires re-pairing, provided the bridge already has an authenticated WhatsApp identity.
Outbound delivery on both transports follows enqueue order (durable sequence, never filesystem hash order), so multi-part results and digest pages arrive in order across restarts and retries.
That keep-alive decision reads only the durable local Telegram configuration, so a transiently unreadable token file cannot stop a configured fallback; failed deliveries are reported and retried instead. Proactive fallback alerts retain all AFK and preference gates. An unavailable report attachment backs off and retries like a failed send instead of stalling the fallback tick. Telegram's server receipt does not prove human readership; a crash after a send but before its local receipt can duplicate a message. No paid messaging feature is used. Telegram is **not activated** by installing the addon.

## Private state and lifecycle

Bridge credentials, queues, receipts, and settings live outside Firstmate under the per-home directory `${XDG_STATE_HOME:-~/.local/state}/firstmate-whatsapp/<home-hash>/whatsapp/`, where `<home-hash>` derives from the canonical `FM_HOME`.
Set `FM_DELEGATE_STATE` to an absolute directory to select another private location.
`FM_STATE_OVERRIDE`, when used, selects Firstmate's state only.
The extension binds its state to one Firstmate home to prevent accidental reuse.
Directories are mode 700 and state files mode 600.
Never commit or share these files.

`disable` stops automatic AFK notification eligibility; stop `run` with Ctrl-C to stop all bridge traffic.
Stopping preserves the linked session; unlink it from the phone to revoke it.
The runtime can be supervised by an existing process manager using the same explicit environment.
Do not launch a second copy against the same state directory.
After an unclean shutdown, inspect the reported `run.lock` and confirm its recorded process is gone before removing that lock directory.

`./bin/fm-whatsapp.sh doctor` is a read-only diagnostic for operators and process managers.
It classifies bridge health and recovery posture without connecting: connected versus disconnected transports, live versus stale single-instance lock ownership (including lock age and a lock recorded for another Firstmate home or private state directory, which usually means the service manager exports a mismatched `FM_HOME` or `FM_DELEGATE_STATE`), queued, pending, and uncertain request counts, handoff receipts left uncertain or mid-publication by an interrupted bridge, inbox wake adapter configuration and controller watcher beacon liveness, and fresh connected health that no live lock owns.
Each finding names the exact safe next action, such as aligning the service-manager environment or comparing a handoff receipt with Firstmate's pending and handled inbox.
Diagnostics never remove a lock, retry an uncertain handoff, restart a service, or mutate queues, and they never print credentials, phone numbers, or message bodies; recovery stays manual and bounded by inspection.

Inbound messages are accepted only from the selected private chat.
Other contacts, groups, forwarded content, history, and unsupported media are ignored. Text is handed to the controller as a request, never evaluated as shell code by the bridge.
Accepted requests are journaled before handing off to Firstmate.
The adapter recovers already-published inbox notes instead of blindly submitting duplicates.
If the inbox helper was interrupted and publication cannot be proved, the request stays pending for operator inspection.
Its private `whatsapp/handoffs/` receipt preserves the exact envelope and publication phase.
Check both Firstmate's pending and handled inbox and ensure the old helper has exited before attempting recovery; do not delete the receipt and blindly retry a potentially delivered instruction.
Notifications wait for a matching server acknowledgement; this does not prove that a person read them.
Outbound delivery is journaled: a durable receipt is written before the queued entry is removed, so a restart after a crash between those steps recovers without a second send.
Sends the server accepted but whose local receipt was lost can still duplicate on retry: delivery is at-least-once, never exactly-once.
Delivery receipts are retained for 24 hours like inbound receipts; within that window duplicate suppression and quoted-reply context are provable, and unsent queued messages never expire on their own except proactive alerts whose session ended or whose decision is no longer open.
See [the outbound delivery journal](docs/delivery.md).
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
WhatsApp can disconnect unofficial clients; the optional paired Telegram fallback stays in this independent repository.
