#!/usr/bin/env bash
# Read-only projection of recorded open decisions; independent of AFK/extension enablement.
set -euo pipefail
[ "${1:-}" = --json ] && [ "$#" -eq 1 ] || exit 2
: "${FM_HOME:?set FM_HOME explicitly}"
code_root=${FM_CODE_ROOT:-$FM_HOME}
state=${FM_STATE_OVERRIDE:-$FM_HOME/state}
case "$FM_HOME:$code_root:$state" in /*:/*:/*) ;; *) exit 2 ;; esac
command -v jq >/dev/null 2>&1 || { echo 'fm-whatsapp-decisions: jq is required to read recorded decisions' >&2; exit 1; }
# Use Firstmate's installed status parser rather than copying its status schema.
# shellcheck source=/dev/null
. "$code_root/bin/fm-afk-contract.sh"
rows=$(
  for meta in "$state"/*.meta; do
    [ -f "$meta" ] && [ ! -L "$meta" ] || continue
    task=${meta##*/}; task=${task%.meta}
    while IFS=$'\t' read -r key verb note || [ -n "$key" ]; do
      [ "$verb" = needs-decision ] || continue
      jq -cn --arg task "$task" --arg key "$key" --arg text "$note" \
        '{task:$task,key:$key,text:$text}'
    done < <(status_open_decisions "$state/$task.status")
  done
)
printf '%s\n' "$rows" | jq -sc '{schema:"fm-whatsapp-decisions.v1",decisions:.}'
