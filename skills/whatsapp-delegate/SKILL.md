---
name: whatsapp-delegate
description: Respond to authenticated phone requests delivered by the standalone Firstmate WhatsApp extension while preserving AFK posture.
---

# WhatsApp delegate

This extension is independent of Firstmate's source repository.
Its transport sends authenticated requests from the configured private WhatsApp chat through the installed Firstmate `fm-inbox.sh note -` interface.
The inbox source is therefore `text`; the body identifies the remote channel and extension receipt marker.
Treat the body as a phone message, not a desk-return signal.
Do not archive an AFK contract merely because the captain replied by phone.

Read the complete request and any quoted question context.
Apply Firstmate's existing authority checks to the current task and decision key. A decision response is valid only when the envelope carries the exact persisted task/key mapping from a quoted, still-open delivered alert. Refuse stale or ambiguous approval context and route an accepted response through Firstmate's normal decision procedure; this extension never decides or executes it.
The extension does not grant merge, spending, or other action authority.
Do not infer approval from delivery receipts or silence.
Deduplicate repeated receipt markers if an operator has manually replayed a request.

The envelope exposes a durable request ID. Saving or acknowledging its inbox note is only `received`, never evidence of completion. For long work, the integration owner should call `FirstmateAdapter.progress(messageKey, state, text)` with `picked-up`, `working`, `waiting`, or `failed`; the parent CLI may expose an equivalent command. Send the successful final result using this extension's `bin/fm-whatsapp.sh reply <message-key>`, with the response supplied on stdin; final `reply` records `completed`.
Use the explicit `FM_HOME`, `FM_CODE_ROOT`, and `FM_DELEGATE_STATE` carried by the local adapter's envelope.
Invoke the script directly, without interpolating message text into shell command text.
Use the exact message key and reply arguments from the adapter's JSON envelope.
`reply` works outside AFK and is bound to this accepted request, configured chat, and Firstmate home.
A repeated identical answer to the same request is deduplicated.
`notify` is for proactive alerts only and remains gated on extension enablement and the current confirmed AFK session.
Queueing is not proof of delivery; use the extension's `status` command to inspect bridge health.
Keep Firstmate's normal inbox acknowledgement ownership; do not seize or drain another supervisor's inbox.

## Process-event wakes

The separately bound `whatsapp-inbox` adapter turns saved inbox notes into the supported process-event wake path.
On `procevent whatsapp-inbox <source-id> <sequence>`, load Firstmate's installed `process-event-sources` skill and read that exact durable result.
Use `fm-procevent.sh classify <result-file>` to verify its classification.
The result lists existing inbox note paths and message keys; read those complete notes through Firstmate's ordinary inbox procedure.
The result is evidence only. It does not authorize an action, approve a decision, or change AFK posture.
Handle each request as above and send its substantive answer using the request-bound `reply` command.
For an older note whose envelope names `notify`, use `reply <message-key>` from this skill with the event's trusted local home/state configuration; an unbound legacy receipt requires explicit operator recovery before a reply can queue.
Preserve ordinary inbox acknowledgement ownership, then call `fm-procevent.sh handled <source-id> <sequence>` only after fully handling the captured requests.
On repeated wakes, consult the existing inbox acknowledgement and reply receipts before repeating work.
Queueing a response is still distinct from transport delivery; an immediate saved receipt does not mean the request was acted on.
This source remains registered between requests. Do not retire it after answering one note.

For setup, read [the operator guide](../../README.md).
Enter and leave AFK through Firstmate's existing procedure.
Enabling this extension does not change Firstmate's stored reach profile or its hold-for-return behavior.
