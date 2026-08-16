FROM node:22-bookworm-slim AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY ui ./ui
RUN npm run build

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src ./src
COPY --from=web-build /app/dist ./dist

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 7337
CMD ["node", "src/server.js"]
