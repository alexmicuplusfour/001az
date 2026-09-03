# API + frontend in one image: express serves the static files (STATIC_DIR
# defaults to ./public baked in below); Caddy in front does TLS and proxying.
FROM node:22-slim

# poppler renders PDF page-1 previews (pdftoppm/pdfinfo in sources/pdf.js);
# ffmpeg renders audio waveform faces (showwavespic in faces/waveform.js);
# without either, those files still ingest — they just get a badge, not a
# thumbnail. The dejavu font is what text-file "page peek" previews (SVG text
# via sharp) draw with.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so code changes don't bust the npm layer. npm ci must run
# in the container: the host node_modules carries win32 sharp binaries.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Server-owned state (uploads + thumbnails) lives on a volume at /data.
# The transformers cache dir must be node-owned before we switch users so the
# pre-download (and runtime writes) succeed without permission errors.
RUN mkdir -p /data/gallery /data/thumbnails /data/ingest /data/plugins /data/backups /data/.npm && chown -R node:node /data \
  && mkdir -p /app/node_modules/@huggingface/transformers/.cache \
  && chown -R node:node /app/node_modules/@huggingface/transformers
USER node

# Pre-download the local embedding model so the first embed sweep isn't blocked
# by a ~90 MB network fetch at runtime.
RUN node -e "import('@huggingface/transformers').then(({pipeline})=>pipeline('feature-extraction','Xenova/bge-small-en-v1.5',{dtype:'q8'}).then(()=>process.exit(0)))"

ENV HOST=0.0.0.0 \
    PORT=3001 \
    GALLERY_DIR=/data/gallery \
    THUMBS_DIR=/data/thumbnails \
    PLUGINS_DIR=/data/plugins \
    BACKUPS_DIR=/data/backups \
    npm_config_cache=/data/.npm

# Mirrors npm_config_cache for the storage gauge, which must not read the
# npm_config_* name: `npm run` injects that one on dev machines, pointing at
# the developer's PERSONAL cache (storage.js measures only what it names).
ENV NPM_CACHE_DIR=/data/.npm

EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/server.js"]
