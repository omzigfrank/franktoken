FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY electron.vite.config.js ./
COPY src ./src
COPY resources ./resources
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    FRANKTOKEN_HOST=0.0.0.0 \
    FRANKTOKEN_PORT=4319 \
    FRANKTOKEN_DATA_FILE=/app/data/events.jsonl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY src/main/providers ./src/main/providers
COPY --from=build /app/out/renderer ./out/renderer
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 4319
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4319/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/index.js"]
