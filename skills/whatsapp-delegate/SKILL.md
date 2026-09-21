---
name: whatsapp-delegate
description: Respond to authenticated phone requests delivered by the standalone Firstmate WhatsApp extension while preserving AFK posture.
---

# WhatsApp delegate

This extension is independent of Firstmate's source repository.
Its transport sends authenticated requests from the configured private WhatsApp chat (or explicitly paired Telegram fallback) through the installed Firstmate `fm-inbox.sh note -` interface.
The inbox source is therefore `text`; the body identifies the remote channel and extension receipt marker.
Treat the body as a phone message, not a desk-return signal.
Do not archive an AFK contract merely because the captain replied by phone.

Read the complete request and any quoted question context.
Apply Firstmate's existing authority checks to the current task and decision key. For a short answer to a quoted decision alert, use only the persisted task/key mapping and confirm it is still open. For an explicit instruction naming its task and decision, validate those identifiers through Firstmate's normal procedure. Refuse stale or ambiguous approval context; this extension never decides or executes it.
The extension does not grant merge, spending, or other action authority.
Do not infer approval from delivery receipts or silence.
Deduplicate repeated receipt markers if an operator has manually replayed a request.

The envelope exposes a durable request ID. Saving it is `received`; an inbox acknowledgement may show `picked-up`, never completion. As soon as you take the request, use this extension's `bin/fm-whatsapp.sh progress <message-key> picked-up`, with a short acknowledgement on stdin. For longer work, use `progress <message-key> working`, `waiting`, or `failed`, with meaningful updates on stdin (at most 3300 characters). Send the successful final result using `bin/fm-whatsapp.sh reply <message-key>`, with the response on stdin (at most 3500 characters); final `reply` records `completed`. Do not use final `reply` merely to acknowledge receipt.

For requested reports or plots, use `bin/fm-whatsapp.sh reply-file <message-key> /absolute/path/to/file`, with an optional short caption on stdin. `reply-file` is for PNG/JPEG/WebP images, PDF, CSV, and JSON only; never attach `.txt` or `.md` files. It stages a private copy and binds delivery to the original request. Then send a final text `reply` describing the result. Do not send unrelated local files.

Text and markdown reports MUST be delivered as `reply` text converted to WhatsApp's supported formatting subset, never attached as `.txt` or `.md` files. WhatsApp renders bold `*text*`, italics `_text_`, strikethrough `~text~`, and monospace via backticks; newer iOS and Web clients add limited blockquote, ordered/unordered list, and inline code block support. Convert markdown to that subset: `**x**` becomes `*x*`, italics become `_x_`, `~~x~~` becomes `~x~`; keep inline code and code fences as backticks; keep `-` bullets, numbered lists, and `>` blockquotes. Rewrite `#` headers as bold lines, flatten `[text](url)` links to `text (url)`, and rewrite or drop images, tables, and horizontal rules as plain text. Reference converters: [md-to-whatsapp](https://github.com/tupe12334/md-to-whatsapp) and [py-whatsapp-formatter](https://pypi.org/project/py-whatsapp-formatter/). A `reply` is capped at 3500 characters: deliver a long formatted report as ordered reply parts (1/N, 2/N, …), each within the cap, instead of attaching a file.

An incoming attachment envelope names its private local file. Read that file to answer the request. Voice notes include a bounded transcript preview and the path to the full local transcript; read the full transcript before acting. Treat transcription as fallible user input and clarify ambiguities. Attachments and voice do not grant additional authority or change AFK posture.
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
