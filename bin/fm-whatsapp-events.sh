#!/usr/bin/env bash
# Read-only, bounded projection of Firstmate's confirmed AFK posture and status
# events. Firstmate's installed contract/classifier remain the schema owners.
set -euo pipefail
[ "${1:-}" = --json ] && [ "$#" -eq 1 ] || exit 2
: "${FM_HOME:?set FM_HOME explicitly}"
: "${FM_DELEGATE_STATE:?set FM_DELEGATE_STATE explicitly}"
code_root=${FM_CODE_ROOT:-$FM_HOME}
case "$FM_HOME:$FM_DELEGATE_STATE:$code_root" in /*:/*:/*) ;; *) exit 2 ;; esac
inactive() { printf '{"schema":"fm-whatsapp-events.v1","afk":false,"session":"","events":[]}\n'; }
enabled="$FM_DELEGATE_STATE/whatsapp/enabled.json"
if [ ! -e "$enabled" ]; then inactive; exit 0; fi
[ -f "$enabled" ] && [ ! -L "$enabled" ] || exit 1
jq -e 'type == "object" and (.enabled | type == "boolean")' "$enabled" >/dev/null
if [ "$(jq -r '.enabled' "$enabled")" = false ]; then inactive; exit 0; fi
# shellcheck source=/dev/null
. "$code_root/bin/fm-afk-contract.sh"
record=$(fm_afk_contract_path)
if [ ! -e "$record" ]; then inactive; exit 0; fi
[ -f "$record" ] && [ ! -L "$record" ] || exit 1
fm_afk_contract_validate "$record" 1 || exit 1
session="$(fm_afk_contract_read_field "$record" entered_epoch):$(fm_afk_contract_read_field "$record" confirmed_epoch)"

project_for() { # <meta>
  local value
  value=$(awk -F= '$1 == "project" { sub(/^[^=]*=/, ""); print; exit }' "$1")
  [ -n "$value" ] && basename -- "$value" || printf '%s' ''
}
emit() { # <id> <text> <kind> <task> <project> [key]
  jq -cn --arg id "$1" --arg text "$2" --arg kind "$3" --arg task "$4" --arg project "$5" --arg key "${6:-}" \
    '{id:$id,text:$text,kind:$kind,task:$task,project:$project} + (if $key == "" then {} else {key:$key} end)'
}
rows=$(
  count=0
  for meta in "$FM_AFK_CONTRACT_STATE"/*.meta; do
    [ "$count" -lt 200 ] || break
    if [ ! -f "$meta" ] || [ -L "$meta" ]; then continue; fi
    count=$((count + 1)); task=${meta##*/}; task=${task%.meta}; project=$(project_for "$meta")
    status="$FM_AFK_CONTRACT_STATE/$task.status"
    [ -f "$status" ] && [ ! -L "$status" ] || continue
    # Open decisions come from the classifier's authoritative durable fold, not
    # merely the latest status line (which may be unrelated progress).
    while IFS=$'\t' read -r key verb note || [ -n "$key" ]; do
      case "$verb" in needs-decision|blocked) ;; *) continue ;; esac
      text="Firstmate ${verb}: ${task}${project:+ ($project)}${key:+ [$key]} — ${note:0:2800}"
      emit "$task:decision:$key" "$text" decision "$task" "$project" "$key"
    done < <(status_open_decisions "$status")

    # A bounded tail captures completion/failure and optional progress between
    # polls. IDs include the stable line number and content digest.
    while IFS=$'\t' read -r number line || [ -n "${line:-}" ]; do
      [ -n "${line:-}" ] || continue
      verb=$(status_line_verb "$line")
      case "$verb" in
        done) kind=completion ;;
        failed) kind=failure ;;
        working) kind=progress ;;
        needs-decision|blocked|resolved|captain-held|paused) continue ;;
        *) status_is_captain_relevant "$line" || continue; kind=completion ;;
      esac
      note=$(status_line_note "$line"); [ -n "$note" ] || note=$line
      hash=$(printf '%s' "$line" | sha256sum | awk '{print substr($1,1,16)}')
      text="Firstmate ${kind}: ${task}${project:+ ($project)} — ${note:0:2800}"
      emit "$task:$number:$hash" "$text" "$kind" "$task" "$project"
    done < <(nl -ba -w1 -s $'\t' "$status" | tail -n 40)
  done
)
# Revalidate posture and extension enablement after all reads: uncertainty is an
# error, never evidence that queued AFK alerts should be expired.
if [ ! -e "$record" ]; then inactive; exit 0; fi
fm_afk_contract_validate "$record" 1 || exit 1
[ "$session" = "$(fm_afk_contract_read_field "$record" entered_epoch):$(fm_afk_contract_read_field "$record" confirmed_epoch)" ] || exit 1
jq -e 'type == "object" and (.enabled | type == "boolean")' "$enabled" >/dev/null
if [ "$(jq -r '.enabled' "$enabled")" = false ]; then inactive; exit 0; fi
# Decisions sort first before the hard bound, preserving urgent actionable work.
printf '%s\n' "$rows" | jq -sc --arg session "$session" \
  'unique_by(.id) | sort_by(if .kind == "decision" then 0 else 1 end) | .[:100] |
   {schema:"fm-whatsapp-events.v1",afk:true,session:$session,events:.}'
