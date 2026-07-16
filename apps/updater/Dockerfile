# Bifrost updater sidecar — watches a shared trigger and, on request, pulls the latest
# server image and recreates it via docker compose. Based on the official Docker CLI image,
# which bundles the compose v2 plugin. It is the only container given the Docker socket.
FROM docker:27-cli
COPY updater.sh /usr/local/bin/updater.sh
RUN chmod +x /usr/local/bin/updater.sh
ENTRYPOINT ["/usr/local/bin/updater.sh"]
