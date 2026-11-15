#!/usr/bin/env bash
# Pull the latest version from Git and restart the service.
# Run on the mini PC:  sudo /opt/wave-lighting/deploy/update.sh [branch]
# The data/ folder (layout, pairing, password) is not in Git and is kept.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wave-lighting}"
BRANCH="${1:-main}"
SERVICE="${SERVICE:-wave-lighting}"
RUN_AS="${RUN_AS:-wave}"

cd "$APP_DIR"
echo "Updating $APP_DIR to origin/$BRANCH…"
sudo -u "$RUN_AS" git fetch --prune origin
sudo -u "$RUN_AS" git checkout "$BRANCH"
sudo -u "$RUN_AS" git reset --hard "origin/$BRANCH"
sudo -u "$RUN_AS" npm ci --omit=dev
cp deploy/wave-lighting.service /etc/systemd/system/wave-lighting.service
systemctl daemon-reload
systemctl restart "$SERVICE"
sleep 2
systemctl --no-pager --lines=5 status "$SERVICE" || true
echo "Now running $(sudo -u "$RUN_AS" git log -1 --format='%h %s')"
