FROM mwader/static-ffmpeg:latest AS ffmpeg

FROM n8nio/n8n:latest

USER root

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

RUN chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
    mkdir -p /home/node/.n8n && \
    chown -R node:node /home/node/.n8n

USER node
