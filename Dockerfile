FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/dispatcher/package.json packages/dispatcher/package.json
COPY packages/worker/package.json packages/worker/package.json
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY packages ./packages
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production FORGECREW_CONFIG=/config/config.yaml
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/dispatcher/dist ./packages/dispatcher/dist
RUN mkdir -p /data /config && chown node:node /data /config
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/dispatcher/dist/main.js"]
