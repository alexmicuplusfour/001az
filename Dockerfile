# API + frontend in one image: express serves the static files (STATIC_DIR
# defaults to the repo root baked in below); Caddy in front does TLS and proxying.
FROM node:22-slim

# poppler renders PDF page-1 previews (pdftoppm/pdfinfo in sources/doc.js);
# without it docs still ingest, they just get no thumbnail.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so code changes don't bust the npm layer. npm ci must run
# in the container: the host node_modules carries win32 sharp binaries.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Server-owned state (uploads + thumbnails) lives on a volume at /data.
RUN mkdir -p /data/gallery /data/thumbnails && chown -R node:node /data
USER node

ENV HOST=0.0.0.0 \
    PORT=3001 \
    GALLERY_DIR=/data/gallery \
    THUMBS_DIR=/data/thumbnails

EXPOSE 3001
CMD ["node", "server/server.js"]
