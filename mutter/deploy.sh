#!/bin/bash
# Build (if needed) and deploy the patched mutter libraries.
# Revert with ./revert.sh. Run with sudo only for the install step.
set -euo pipefail

BASE=/home/tristonarmstrong/mutter-vrr
SRC=$BASE/mutter-50.5/_build
BK=/home/tristonarmstrong/mutter-backup

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
