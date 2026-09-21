# Bot-Image für die Hetzner-Box.
#
# Bewusst OHNE Browser: die Playwright-Navigation läuft nicht mehr hier, sondern
# auf dem Laptop (GC sperrt Rechenzentrums-IPs). Dadurch ist dieses Image klein
# und startet in Sekunden statt in Minuten.

FROM node:22-slim

# Deutsche Zeit, sonst stehen in Protokollen und Notizen UTC-Zeitstempel.
ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    WWS_DATA=/app/data

WORKDIR /app

# tini als PID 1: sonst laufen bei einem Neustart Zombie-Prozesse auf und
# STRG-C / docker stop kommen nicht sauber beim Node-Prozess an.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

# Erst die Paketlisten — so muss npm nur neu laufen, wenn sich wirklich
# Abhängigkeiten geändert haben, nicht bei jeder Code-Änderung.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/wissen

# Die Auftragsstelle, an der sich der Laptop-Agent meldet.
EXPOSE 8788

# Gesundheitsprüfung ohne zusätzliches Paket — Node kann selbst HTTP.
HEALTHCHECK --interval=60s --timeout=8s --start-period=30s --retries=3 \
  CMD node -e "const p=process.env.AGENT_PORT||8788; if(!process.env.AGENT_TOKEN) process.exit(0); fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bot.js"]
