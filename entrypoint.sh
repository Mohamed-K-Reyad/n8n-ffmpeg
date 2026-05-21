#!/bin/sh
# entrypoint.sh
# يشغل media-processor في الخلفية ثم يبدأ n8n

set -e

echo "[entrypoint] Starting media-processor..."
node /app/media-processor.js &
MEDIA_PID=$!
echo "[entrypoint] media-processor PID: $MEDIA_PID"

# انتظر ثانيتين للتأكد أنه بدأ
sleep 2

# تحقق أنه يعمل
if kill -0 $MEDIA_PID 2>/dev/null; then
  echo "[entrypoint] ✅ media-processor running"
else
  echo "[entrypoint] ⚠️ media-processor failed to start — continuing anyway"
fi

echo "[entrypoint] Starting n8n..."
exec /docker-entrypoint.sh "$@"
