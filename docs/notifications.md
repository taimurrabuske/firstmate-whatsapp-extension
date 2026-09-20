# Notification integration

`bin/fm-whatsapp-events.sh --json` remains a read-only v1 snapshot. Each event now also has `kind`, `task`, `project`, and an optional decision `key`. Kinds are `completion`, `failure`, `decision`, and `progress`. The projection sources the installed Firstmate AFK validator and status classifier; it does not own or duplicate their schemas. It reads at most 200 active task metadata files, the last 40 status lines per task, and emits at most 100 events. Open decisions use Firstmate's authoritative status fold.

## Parent integration API

Import `NotificationPolicy` from `bin/fm-whatsapp/notifications.mjs` and construct it with the private WhatsApp state directory:

```js
const policy = new NotificationPolicy({ stateDir: store.root });
```

- `policy.plan(snapshot, epochSeconds)` captures unseen eligible events durably and returns zero or more deterministic delivery objects. The first snapshot of every newly entered AFK session baselines completion, failure, and progress events, avoiding historical floods. An unseen decision that is still open is captured immediately even on that first AFK snapshot.
- Every delivery has exactly `{id, text, kind, task, project, session, sourceIds, sourceEvents, event, automatic}`. `event` is the sole source event for a one-event delivery and `null` for a multi-event digest page; `sourceEvents` is always complete. Preserve `event`, `sourceEvents`, and `sourceIds` in the outbox for decision expiration/mapping.
- Enqueue each returned delivery using its deterministic `id`, `text`, `session`, and metadata. **Only after that entire delivery is durably saved**, call `policy.commit(delivery)`. An atomic parent `enqueueBatch(deliveries)` followed by commits is ideal; sequential enqueue-then-commit is also safe because each digest page owns disjoint whole source events. Until commit, restart and polling return deterministic work, and committing one page leaves every later page pending.
- `policy.allow(job, snapshot, epochSeconds)` applies AFK, quiet-hour, kind, and subscription policy immediately before send. It never grants authority and always refuses proactive delivery outside a confirmed AFK snapshot.
- `policy.command(text)` returns `{recognized:false}` for normal chat. A recognized local shortcut returns display text and updated preferences. Do not route unrecognized text away from the normal request path.

Exact shortcuts (case-insensitive) are:

- `alerts`, `alerts on`, `alerts off`
- `alerts completion|failure|decisions|progress on|off`
- `alerts decisions urgent on|off`
- `subscribe project NAME`, `unsubscribe project NAME`
- `subscribe task NAME`, `unsubscribe task NAME`
- `quiet HH:MM-HH:MM IANA/Timezone`, `quiet off`
- `digest MINUTES` (0–1440)

Task subscription overrides project subscription; unspecified scopes default on. Progress defaults off. Decisions, failures, and completions default on. Decisions bypass digest by default but never bypass quiet hours or AFK. With urgent decisions disabled, they wait for the digest timer but each retains its own message so expiration and quoted task/key context cannot affect other reports. Preferences and the capture ledger are mode-0600 JSON in the mode-0700 state directory.

## Limits

Project names are the basename of the task metadata `project` path; tasks without that field have an empty project. The projection intentionally covers local active task metadata only. It does not synthesize events from panes, modify Firstmate, imply return from AFK, answer decisions, or bypass merge/spend/task gates. Digest pages are deterministically packed at whole-event boundaries and never exceed 3500 characters. A source that fits WhatsApp but cannot fit digest markup is emitted unchanged as a standalone delivery; a source over 3500 characters is rejected explicitly and is never truncated or acknowledged.
