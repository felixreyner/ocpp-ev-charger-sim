# One image recipe for both apps. Pick which one with --build-arg APP=csms|charger.
FROM node:22-alpine
WORKDIR /app

# Install dependencies first so they are cached between code changes.
COPY package.json package-lock.json ./
COPY packages/ocpp/package.json packages/ocpp/
COPY packages/ui/package.json packages/ui/
COPY apps/csms/package.json apps/csms/
COPY apps/charger/package.json apps/charger/
RUN npm ci --no-audit --no-fund

COPY . .
ARG APP
RUN test -n "$APP" && npm run build -w @sim/${APP}
ENV APP=${APP} NODE_ENV=production
CMD ["sh", "-c", "exec npx tsx apps/$APP/server/index.ts"]
