#!/usr/bin/env bash
set -euo pipefail
umask 077
BASE="$HOME/apps/annotation-platform"
SHARED="$BASE/shared"
DEST="$SHARED/backups"
mkdir -p "$DEST"
exec 9>"$SHARED/backup.lock"
flock -n 9 || exit 0
STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
ARCHIVE="$DEST/workspace-$STAMP.tar.gz"
RESTART=false
cleanup() {
  rm -f "$ARCHIVE.partial"
  if $RESTART; then systemctl --user start annotation-platform.service; fi
}
trap cleanup EXIT
# Quiesce writes so annotation files and derived edit logs share one snapshot.
if systemctl --user is-active --quiet annotation-platform.service; then
  RESTART=true
  systemctl --user stop annotation-platform.service
fi
SOURCES=()
# Retain archived legacy data in backups without requiring it on new installs.
if [ -d "$SHARED/workspace" ]; then SOURCES+=(workspace); fi
if [ -d "$SHARED/review-workspaces" ]; then SOURCES+=(review-workspaces); fi
if [ "${#SOURCES[@]}" -eq 0 ]; then echo "No persistent workspaces to back up" >&2; exit 1; fi
tar -czf "$ARCHIVE.partial" -C "$SHARED" "${SOURCES[@]}"
tar -tzf "$ARCHIVE.partial" >/dev/null
mv "$ARCHIVE.partial" "$ARCHIVE"
if $RESTART; then
  systemctl --user start annotation-platform.service
  RESTART=false
fi
find "$DEST" -maxdepth 1 -type f -name 'workspace-*.tar.gz' -mtime +14 -delete
# Also bound disk growth if manually triggered more than once per day.
mapfile -t archives < <(find "$DEST" -maxdepth 1 -type f -name 'workspace-*.tar.gz' | sort -r)
for archive in "${archives[@]:14}"; do rm -- "$archive"; done
printf 'Backup ready: %s\n' "$ARCHIVE"
