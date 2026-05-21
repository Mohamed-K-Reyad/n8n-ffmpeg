FROM mwader/static-ffmpeg:latest AS ffmpeg
FROM n8nio/n8n:latest

USER root

# نسخ FFmpeg
COPY --from=ffmpeg /ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
RUN chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

# نسخ media-processor و entrypoint
COPY media-processor.js /app/media-processor.js
COPY entrypoint.sh      /entrypoint.sh
RUN chmod +x /entrypoint.sh && \
    mkdir -p /tmp/media-processor && \
    mkdir -p /home/node/.n8n && \
    chown -R node:node /home/node/.n8n /tmp/media-processor /app/media-processor.js

USER node

ENTRYPOINT ["/entrypoint.sh"]
