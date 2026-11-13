#!/bin/sh
# Docker creates a missing bind-mount folder (compose's ./backups) owned by
# root, where the node user can't write. So the image starts as root: hand
# the backups folder to node, then run node commands as node. Anything else
# (a shell) runs as whoever started it.
if [ "$1" = node ] && [ "$(id -u)" = 0 ]; then
  # Best effort: a folder that still refuses (a read-only mount) fails the
  # backup with its own error, as before.
  chown node:node "$BACKUPS_DIR" 2>/dev/null || true
  export HOME=/home/node # Docker set root's home for the root start
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
