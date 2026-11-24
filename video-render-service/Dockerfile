FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    HF_HOME=/models \
    VIDEO_RENDER_HOST=0.0.0.0 \
    VIDEO_RENDER_PORT=4399 \
    VIDEO_RENDER_STORAGE_ROOT=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && python3 -m pip install --break-system-packages --no-cache-dir faster-whisper opencc-python-reimplemented \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src

RUN mkdir -p /data /models \
    && chown -R node:node /app /data /models

USER node
EXPOSE 4399
VOLUME ["/data", "/models"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4399/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
