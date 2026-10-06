#!/bin/sh
set -e
# Start ClamAV daemons from the base image (freshclam keeps signatures updated), then the HTTP wrapper.
/init &
for i in $(seq 1 120); do [ -S /run/clamav/clamd.sock ] || [ -S /tmp/clamd.sock ] && break; sleep 2; done
exec node /app/server.mjs
