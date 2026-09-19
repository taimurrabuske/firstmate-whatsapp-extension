#!/usr/bin/env bash
# Read-only projection of Firstmate's confirmed AFK posture and open questions.
# The extension owns enablement; Firstmate alone owns posture and authority.
# Usage: FM_HOME=<home> FM_DELEGATE_STATE=<state> fm-whatsapp-events.sh --json
set -euo pipefail
[ "${1:-}" = --json ] && [ "$#" -eq 1 ] || exit 2
: "${FM_HOME:?set FM_HOME explicitly}"
: "${FM_DELEGATE_STATE:?set FM_DELEGATE_STATE explicitly}"
code_root=${FM_CODE_ROOT:-$FM_HOME}
case "$FM_HOME:$FM_DELEGATE_STATE:$code_root" in /*:/*:/*) ;; *) exit 2 ;; esac
inactive() {
  printf '{"schema":"fm-whatsapp-events.v1","afk":false,"session":"","events":[]}\n'
}
enabled="$FM_DELEGATE_STATE/whatsapp/enabled.json"
if [ ! -e "$enabled" ]; then inactive; exit 0; fi
[ -f "$enabled" ] && [ ! -L "$enabled" ] || exit 1
jq -e 'type == "object" and (.enabled | type == "boolean")' "$enabled" >/dev/null
if [ "$(jq -r '.enabled' "$enabled")" = false ]; then inactive; exit 0; fi
# Use the installed owner's validator and classifier, without copying its schema.
# shellcheck source=/dev/null
. "$code_root/bin/fm-afk-contract.sh"
record=$(fm_afk_contract_path)
if [ ! -e "$record" ]; then inactive; exit 0; fi
[ -f "$record" ] && [ ! -L "$record" ] || exit 1
fm_afk_contract_validate "$record" 1 || exit 1
session="$(fm_afk_contract_read_field "$record" entered_epoch):$(fm_afk_contract_read_field "$record" confirmed_epoch)"
rows=$(
  for meta in "$FM_AFK_CONTRACT_STATE"/*.meta; do
    [ -f "$meta" ] && [ ! -L "$meta" ] || continue
    task=${meta##*/}; task=${task%.meta}
    while IFS=$'\t' read -r key verb note || [ -n "$key" ]; do
      [ "$verb" = needs-decision ] || continue
      jq -cn --arg id "$task:$key" --arg task "$task" --arg key "$key" --arg text "$note" \
        '{id:$id,text:("Firstmate: recorded decision pending\nTask: " + $task + "\nKey: " + $key + "\n" + $text[:2800] + "\nReply with !fm note and include the task/key, or quote this alert.")}'
    done < <(status_open_decisions "$FM_AFK_CONTRACT_STATE/$task.status")
  done
)
# A failed read is unknown posture, never proof that an old alert should expire.
if [ ! -e "$record" ]; then inactive; exit 0; fi
fm_afk_contract_validate "$record" 1 || exit 1
if [ "$session" != "$(fm_afk_contract_read_field "$record" entered_epoch):$(fm_afk_contract_read_field "$record" confirmed_epoch)" ]; then
  exit 1
fi
jq -e 'type == "object" and (.enabled | type == "boolean")' "$enabled" >/dev/null
if [ "$(jq -r '.enabled' "$enabled")" = false ]; then inactive; exit 0; fi
printf '%s\n' "$rows" | jq -sc --arg session "$session" \
  '{schema:"fm-whatsapp-events.v1",afk:true,session:$session,events:.}'
