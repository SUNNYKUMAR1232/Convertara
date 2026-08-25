# syntax=docker/dockerfile:1

# --- dependencies -----------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Only the API workspace is needed here; --workspace keeps the web deps out of
# the image entirely.
RUN npm ci --workspace apps/api --include-workspace-root --no-audit --no-fund

# --- build ------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY apps/api apps/api
RUN npm run build --workspace apps/api

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Ghostscript powers pdf.compress. Without it the capability is advertised as
# unavailable rather than silently doing nothing, so this line is what turns
# PDF size targets on.
#
# The fonts are not optional either: image.watermark rasterises text through
# librsvg, and a slim image has no fonts at all - the watermark would come out
# blank with no error anywhere. (pdf.watermark embeds a standard font and does
# not need these.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ghostscript \
      fonts-dejavu-core \
      fontconfig \
      ca-certificates \
      tini \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY package.json ./package.json

RUN mkdir -p /app/data/storage && chown -R node:node /app/data
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
