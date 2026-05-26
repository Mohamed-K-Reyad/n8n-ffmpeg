FROM mwader/static-ffmpeg:latest AS ffmpeg

FROM n8nio/n8n:latest

USER root

# نسخ FFmpeg و FFprobe
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

# إعطاء صلاحيات التنفيذ
RUN chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

# نسخ media processor
COPY media-processor.js /app/media-processor.js

# إنشاء المجلدات المطلوبة وضبط الصلاحيات
RUN mkdir -p /tmp/media-processor \
    && mkdir -p /home/node/.n8n \
    && chown -R node:node /home/node/.n8n \
    && chown -R node:node /tmp/media-processor \
    && chown -R node:node /app/media-processor.js

USER node
