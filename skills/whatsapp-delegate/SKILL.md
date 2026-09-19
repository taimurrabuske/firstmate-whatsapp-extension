---
name: whatsapp-delegate
description: Respond to authenticated phone requests delivered by the standalone Firstmate WhatsApp extension while preserving AFK posture.
---

# WhatsApp delegate

This extension is independent of Firstmate's source repository.
Its transport sends authenticated self-chat requests through the installed Firstmate `fm-inbox.sh note -` interface.
The inbox source is therefore `text`; the body identifies the remote channel and extension receipt marker.
Treat the body as a phone message, not a desk-return signal.
Do not archive an AFK contract merely because the captain replied by phone.

Read the complete request and any quoted question context.
Apply Firstmate's existing authority checks to the current task and decision key.
The extension does not grant merge, spending, or other action authority.
Do not infer approval from delivery receipts or silence.
Deduplicate repeated receipt markers if an operator has manually replayed a request.

Send a concise acknowledgement for long work, then send its result using this extension's `bin/fm-whatsapp.sh notify`, with the response supplied on stdin.
Use the explicit `FM_HOME`, `FM_CODE_ROOT`, and `FM_DELEGATE_STATE` carried by the local adapter's envelope.
Invoke the script directly, without interpolating message text into shell command text.
`notify` is gated on extension enablement and the current confirmed AFK session.
Queueing is not proof of delivery; use the extension's `status` command to inspect bridge health.
Keep Firstmate's normal inbox acknowledgement ownership; do not seize or drain another supervisor's inbox.

For setup, read [the operator guide](../../README.md).
Enter and leave AFK through Firstmate's existing procedure.
Enabling this extension does not change Firstmate's stored reach profile or its hold-for-return behavior.
