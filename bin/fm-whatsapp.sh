#!/usr/bin/env bash
# fm-whatsapp.sh - free, optional WhatsApp linked-device transport for Firstmate.
# Usage: FM_HOME=/absolute/home fm-whatsapp.sh pair [--qr-file /absolute/file]
#        FM_HOME=/absolute/home fm-whatsapp.sh recipient +COUNTRYNUMBER|self
#        FM_HOME=/absolute/home fm-whatsapp.sh run|status|doctor|notify|ping|enable|disable|help
# `notify` reads bounded text on stdin and queues it for the enabled delegate's current
# Firstmate AFK session. `run` serves only the configured private chat.
# `doctor` verifies the installation, private state, single-instance ownership,
# queues, uncertain handoffs, adapter liveness and service-manager binding
# without connecting and without changing anything. The Node CLI owns the exact
# lifecycle, private state and
# command contracts; `help` prints them. No command invokes a model or grants
# approval authority. Install pinned dependencies with: npm ci --prefix bin/fm-whatsapp
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || { echo 'fm-whatsapp: Node 20 or newer is required' >&2; exit 1; }
node_version=$(node --version 2>/dev/null || true)
node_major=${node_version#v}
node_major=${node_major%%.*}
case "$node_major" in ''|*[!0-9]*) node_major=0 ;; esac
[ "$node_major" -ge 20 ] || { echo "fm-whatsapp: Node 20 or newer is required; found ${node_version:-an unusable node}" >&2; exit 1; }
[ -f "$SCRIPT_DIR/fm-whatsapp/cli.mjs" ] || { echo 'fm-whatsapp: installation incomplete; bin/fm-whatsapp/cli.mjs is missing from this checkout' >&2; exit 1; }
exec node "$SCRIPT_DIR/fm-whatsapp/cli.mjs" "$@"
