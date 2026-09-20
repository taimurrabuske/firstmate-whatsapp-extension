# Durable requests integration

The request implementation is transport-independent after authentication. WhatsApp creates a `RequestJournal` entry in `whatsapp/requests/<sha256>.json` before inbox publication. A future transport may use the same journal only after its own selected-chat authorization and must supply explicit `provenance` and the bound `{account, recipient}` route. Route equality is required for context and replies.

## Parent-facing APIs

- `new Bridge({... , summary(command) })`: `summary` is optional. If absent, the backward-compatible `status(command)` callback is used. Commands are `status`, `pending`, `blocked`, `decisions`, `last result`, and `more`. `more` uses a durable per-route cursor.
- `FirstmateAdapter.progress(key, state, text)`: records and queues explicit owner progress. States accepted here are `picked-up`, `working`, `waiting`, and `failed`. It rejects invalid/backward transitions. Use `reply(key, text)` for final successful completion; `reply` durably changes the request to `completed` after its deterministic queue entry exists.
- `await FirstmateAdapter.maintain(options?)`: call from the parent tick. It returns `{key,state,evidence}` reports. After five minutes by default it can re-ring the **same existing inbox note/wake** at most three times. It never republishes a note, executes its body, takes the bridge/owner lock, or changes AFK. Evidence strings distinguish an existing-note re-ring, a stale watcher after exhaustion, and a busy watcher after a failed ring.
- `await FirstmateAdapter.summary(command)`: recorded lifecycle summaries; `status` also includes Firstmate's existing recorded status, and `decisions` reads the existing event projection.
- `RequestJournal` and `REQUEST_STATES` are exported by `bin/fm-whatsapp/requests.mjs` for authenticated transport integration.

Lifecycle is `received -> picked-up/working/waiting/failed`, then `picked-up/working/waiting -> working/waiting/completed/failed` as applicable. Saving a note and sending the immediate receipt leave it at `received`; neither is completion. Inbox handled evidence may advance `received` to `picked-up`. Only explicit `progress` or final `reply` records later states.

Quoted outbound context is loaded only from the durable sent record and must match the exact account/recipient route. Decision replies additionally require persisted `event.kind === "decision"`, exact task/key metadata, and a still-open matching event. Stale and ambiguous approval-like replies are refused locally; the extension never performs a decision. Accepted exact replies are notes directing Firstmate to its normal decision handling.

Unquoted followups include only bounded IDs/states for up to four open requests on the same route. Message bodies are not copied into this context index. This survives restart and cannot cross a recipient change.
