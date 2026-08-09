FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV DRY_RUN=true
ENV ALLOW_UNSIGNED_RETELL=false
ENV PLANITY_BOOKING_ENABLED=false
ENV CAL_MIRROR_ENABLED=false

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/georg-entrypoint

RUN chmod 755 /usr/local/bin/georg-entrypoint \
    && mkdir -p /app/data \
    && chown -R node:node /app
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/georg-entrypoint"]
CMD ["node", "dist/src/server.js"]
