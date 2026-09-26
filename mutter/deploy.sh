#!/bin/bash
# Deploy the patched mutter libraries. Run with sudo.
# Override the mutter work tree and backup dir if yours differ:
#   sudo MUTTER_BASE=/path/to/mutter-50.5 MUTTER_BACKUP=/path/to/backup ./deploy.sh
# MUTTER_BASE is the mutter source root; MUTTER_BACKUP holds the original libs.
set -euo pipefail

BASE="${MUTTER_BASE:-$HOME/mutter-vrr/mutter-50.5}"
SRC="$BASE/_build"
BK="${MUTTER_BACKUP:-$HOME/mutter-backup}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo" >&2
  exit 1
fi

[ -f "$BK/libmutter-18.so.0.0.0" ] || \
  cp -a /usr/lib64/libmutter-18.so.0.0.0 "$BK/"
[ -f "$BK/libmutter-clutter-18.so.0.0.0" ] || \
  cp -a /usr/lib64/mutter-18/libmutter-clutter-18.so.0.0.0 "$BK/"

install -m 755 "$SRC/src/libmutter-18.so.0.0.0" \
  /usr/lib64/libmutter-18.so.0.0.0
install -m 755 "$SRC/clutter/clutter/libmutter-clutter-18.so.0.0.0" \
  /usr/lib64/mutter-18/libmutter-clutter-18.so.0.0.0

echo "installed. Log out and back in to load them."
