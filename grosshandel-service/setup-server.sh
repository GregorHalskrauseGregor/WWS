#!/bin/bash
# Idempotentes Setup fuer den Grosshandel-Service auf einer frischen
# Ubuntu-24/26-Box. Kann mehrfach laufen.
#
# Aufruf:  bash setup-server.sh
#
# Erwartet, dass du als root (oder mit sudo) eingeloggt bist.

set -euo pipefail

echo "=== 1/6 System-Update ==="
export DEBIAN_FRONTEND=noninteractive
apt update -y
apt upgrade -y

echo "=== 2/6 Basis-Pakete ==="
apt install -y curl wget git ufw ca-certificates gnupg nano htop

echo "=== 3/6 Docker installieren ==="
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt update
  apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "Docker bereits installiert: $(docker --version)"
fi

echo "=== 4/6 Service-User + Verzeichnisstruktur ==="
id -u grosshandel >/dev/null 2>&1 || useradd -m -s /bin/bash grosshandel
usermod -aG docker grosshandel
mkdir -p /opt/grosshandel-service/{selectors,data/storage,screenshots,logs}
chown -R grosshandel:grosshandel /opt/grosshandel-service
chmod 700 /opt/grosshandel-service/data/storage

echo "=== 5/6 Firewall ==="
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow ssh >/dev/null
ufw allow 8787 >/dev/null   # Service-Port; spaeter auf WWS-IP einschraenken
ufw --force enable >/dev/null

echo "=== 6/6 Healthcheck ==="
docker --version
docker compose version
echo
echo "=== Setup fertig ==="
echo "Naechste Schritte:"
echo "  cd /opt/grosshandel-service"
echo "  git clone <dein-repo-url> .   (oder git pull, falls schon da)"
echo "  cp .env.example .env  &&  nano .env   (SERVICE_TOKEN, GC_USER/_PASS, ...)"
echo "  docker compose up -d --build"
echo "  curl http://127.0.0.1:8787/health"
