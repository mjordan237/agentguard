#!/bin/sh
# Runs as root so it can fix ownership of a volume mounted at container
# start (e.g. Railway's persistent volumes mount after the image's
# filesystem is built, so a build-time chown doesn't apply to them).
# Then drops to the unprivileged node user before exec'ing the app.
set -eu

if [ -d /data ]; then
  chown -R node:node /data
fi

exec setpriv --reuid=node --regid=node --init-groups "$@"
