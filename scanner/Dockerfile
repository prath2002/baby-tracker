# Malware-scanning companion service for Baby Health (spec §36).
# ClamAV (clamd + freshclam) behind a tiny token-authenticated HTTPS endpoint: POST /scan (raw bytes) -> {clean|infected}.
# Deploy close to your app (e.g. Fly.io region "bom" / Mumbai) and always behind TLS. Never expose clamd's TCP port publicly.
FROM clamav/clamav:stable
RUN apk add --no-cache nodejs
COPY server.mjs /app/server.mjs
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
