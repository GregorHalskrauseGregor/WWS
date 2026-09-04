# Basis: offizielles Playwright-Image mit Chromium und allen Abhängigkeiten.
# Spart uns das manuelle Installieren von System-Libraries.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Nur package.json zuerst fuer besseres Caching
COPY package.json ./
RUN npm install --omit=dev

# Dann der Code
COPY server.js ./
COPY selectors ./selectors

# Verzeichnisse fuer Laufzeitdaten (koennen auch als Volumes gemountet werden)
RUN mkdir -p /app/data/storage /app/screenshots /app/logs
ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

# Healthcheck via node-fetch ist zu teuer; pingen wir einfach den Port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "server.js"]
