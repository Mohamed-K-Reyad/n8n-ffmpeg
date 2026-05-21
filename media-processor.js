#!/usr/bin/env node
/**
 * media-processor.js
 * microservice يعمل داخل نفس container الـ n8n
 * يستقبل طلبات HTTP ويعالجها بـ FFmpeg
 * Port: 3000
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const cp    = require('child_process');
const os    = require('os');

const PORT    = process.env.MEDIA_PROCESSOR_PORT || 3000;
const TMP_DIR = process.env.MEDIA_TMP || '/tmp/media-processor';

fs.mkdirSync(TMP_DIR, { recursive: true });

// ─── helpers ────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function ffmpeg(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d);
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('FFmpeg timeout')); }, timeout);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-600)}`));
    });
  });
}

function cleanup(...files) {
  for (const f of files) try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

// ─── routes ─────────────────────────────────────────────────────────────────

const routes = {};

/**
 * GET /health
 * فحص أن الـ service يعمل
 */
routes['GET /health'] = async (_req, res) => {
  json(res, 200, { ok: true, service: 'media-processor', ffmpeg: true, node: process.version });
};

/**
 * POST /image/save
 * يستقبل base64 صورة → يحفظها كـ PNG
 * body: { b64: string, fileName: string }
 * returns: { ok, filePath, sizeKB }
 */
routes['POST /image/save'] = async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const { b64, fileName } = body;

  if (!b64 || !fileName) return json(res, 400, { ok: false, error: 'b64 و fileName مطلوبان' });

  const outPath = path.join(TMP_DIR, fileName.replace(/[^a-zA-Z0-9._-]/g, '_'));

  try {
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(outPath, buf);
    const sizeKB = Math.round(buf.length / 1024);
    json(res, 200, { ok: true, filePath: outPath, sizeKB });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
};

/**
 * POST /image/black
 * ينتج صورة سوداء كـ fallback
 * body: { fileName: string, width?: number, height?: number }
 * returns: { ok, filePath, b64 }
 */
routes['POST /image/black'] = async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const { fileName, width = 576, height = 1024 } = body;

  const outPath = path.join(TMP_DIR, (fileName || `black_${uid()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_'));

  try {
    await ffmpeg([
      '-f', 'lavfi',
      '-i', `color=c=black:size=${width}x${height}:rate=1`,
      '-frames:v', '1',
      '-y', outPath
    ]);
    const b64 = fs.readFileSync(outPath).toString('base64');
    json(res, 200, { ok: true, filePath: outPath, b64 });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
};

/**
 * POST /image/check
 * يفحص جودة صورة محفوظة
 * body: { filePath: string }
 * returns: { ok, sizeKB, qualityScore, needsRetry }
 */
routes['POST /image/check'] = async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const { filePath } = body;

  if (!filePath) return json(res, 400, { ok: false, error: 'filePath مطلوب' });

  try {
    if (!fs.existsSync(filePath)) {
      return json(res, 200, { ok: true, sizeKB: 0, qualityScore: 0, needsRetry: true, reason: 'الملف غير موجود' });
    }
    const sizeKB = Math.round(fs.statSync(filePath).size / 1024);
    const needsRetry = sizeKB < 50;
    const qualityScore = sizeKB < 50 ? 20 : sizeKB < 200 ? 60 : 90;
    json(res, 200, { ok: true, sizeKB, qualityScore, needsRetry, reason: needsRetry ? 'الملف صغير جداً' : 'جيد' });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
};

/**
 * POST /audio/convert
 * base64 WAV → MP3
 * body: { b64: string, fileName: string }
 * returns: { ok, b64, filePath }
 */
routes['POST /audio/convert'] = async (req, res) => {
  const body  = JSON.parse(await readBody(req));
  const { b64, fileName } = body;

  if (!b64 || b64.length < 100) return json(res, 400, { ok: false, error: 'b64 مطلوب' });

  const id      = uid();
  const wavPath = path.join(TMP_DIR, `${id}.wav`);
  const mp3Name = (fileName || `audio_${id}.mp3`).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.wav$/i, '.mp3');
  const mp3Path = path.join(TMP_DIR, mp3Name);

  try {
    fs.writeFileSync(wavPath, Buffer.from(b64, 'base64'));
    await ffmpeg(['-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-qscale:a', '2', mp3Path]);
    const outB64 = fs.readFileSync(mp3Path).toString('base64');
    cleanup(wavPath, mp3Path);
    json(res, 200, { ok: true, b64: outB64, fileName: mp3Name });
  } catch (e) {
    cleanup(wavPath, mp3Path);
    json(res, 500, { ok: false, error: e.message });
  }
};

/**
 * POST /audio/silence
 * ينتج صوت صامت كـ fallback
 * body: { duration?: number, fileName: string }
 * returns: { ok, b64, fileName }
 */
routes['POST /audio/silence'] = async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const { duration = 30, fileName } = body;

  const mp3Name = (fileName || `silence_${uid()}.mp3`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const mp3Path = path.join(TMP_DIR, mp3Name);

  try {
    await ffmpeg(['-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono`, '-t', String(duration), mp3Path]);
    const b64 = fs.readFileSync(mp3Path).toString('base64');
    cleanup(mp3Path);
    json(res, 200, { ok: true, b64, fileName: mp3Name });
  } catch (e) {
    cleanup(mp3Path);
    json(res, 500, { ok: false, error: e.message });
  }
};

/**
 * POST /video/render
 * الـ endpoint الرئيسي — يجمع الصور والصوت وينتج فيديو
 * body: {
 *   images: [ { b64: string, duration?: number } ],   // مشاهد مرتبة
 *   audioEN: { b64: string },                          // صوت إنجليزي (mp3/wav b64)
 *   audioAR: { b64: string },                          // صوت عربي
 *   videoId: string,
 *   fps?: number,                                      // default 30
 *   width?: number,                                    // default 576
 *   height?: number,                                   // default 1024
 * }
 * returns: { ok, videoB64EN, videoB64AR, durationSec }
 */
routes['POST /video/render'] = async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const {
    images = [],
    audioEN,
    audioAR,
    videoId = uid(),
    fps     = 30,
    width   = 576,
    height  = 1024,
  } = body;

  if (!images.length) return json(res, 400, { ok: false, error: 'images مطلوبة' });

  const workDir = path.join(TMP_DIR, `video_${videoId}_${uid()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const tmpFiles = [];

  try {
    // 1. حفظ كل صورة على الديسك
    const imagePaths = [];
    for (let i = 0; i < images.length; i++) {
      const img     = images[i];
      const imgPath = path.join(workDir, `scene_${String(i).padStart(3,'0')}.png`);
      fs.writeFileSync(imgPath, Buffer.from(img.b64, 'base64'));
      imagePaths.push({ path: imgPath, duration: img.duration || 5 });
      tmpFiles.push(imgPath);
    }

    // 2. بناء concat filter لتجميع الصور كـ slideshow
    const concatListPath = path.join(workDir, 'images.txt');
    const concatContent  = imagePaths.map(img =>
      `file '${img.path}'\nduration ${img.duration}`
    ).join('\n') + `\nfile '${imagePaths[imagePaths.length - 1].path}'`;
    fs.writeFileSync(concatListPath, concatContent);
    tmpFiles.push(concatListPath);

    // 3. بناء slideshow بدون صوت أولاً
    const silentVideoPath = path.join(workDir, 'silent.mp4');
    tmpFiles.push(silentVideoPath);
    await ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', concatListPath,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-y', silentVideoPath
    ], 180000);

    // 4. دالة مساعدة: دمج الصوت مع الفيديو
    async function mergeAudio(audioData, suffix) {
      if (!audioData?.b64 || audioData.b64.length < 100) {
        // لا يوجد صوت — نرجع الفيديو الصامت كـ b64
        const b64 = fs.readFileSync(silentVideoPath).toString('base64');
        return { b64, used: 'silent' };
      }

      const ext      = audioData.b64.length > 1000 ? 'mp3' : 'wav';
      const audioIn  = path.join(workDir, `audio_${suffix}.${ext}`);
      const videoOut = path.join(workDir, `final_${suffix}.mp4`);
      tmpFiles.push(audioIn, videoOut);

      fs.writeFileSync(audioIn, Buffer.from(audioData.b64, 'base64'));

      await ffmpeg([
        '-i', silentVideoPath,
        '-i', audioIn,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        '-map', '0:v:0', '-map', '1:a:0',
        '-y', videoOut
      ], 180000);

      const b64 = fs.readFileSync(videoOut).toString('base64');
      return { b64, used: 'audio' };
    }

    // 5. إنتاج النسختين EN و AR بالتوازي
    const [resultEN, resultAR] = await Promise.all([
      mergeAudio(audioEN, 'EN'),
      mergeAudio(audioAR, 'AR'),
    ]);

    // 6. تنظيف الملفات المؤقتة
    cleanup(...tmpFiles);
    fs.rmSync(workDir, { recursive: true, force: true });

    json(res, 200, {
      ok:         true,
      videoB64EN: resultEN.b64,
      videoB64AR: resultAR.b64,
      enSuccess:  true,
      arSuccess:  true,
      usedAudioEN: resultEN.used,
      usedAudioAR: resultAR.used,
    });

  } catch (e) {
    cleanup(...tmpFiles);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    json(res, 500, { ok: false, error: e.message });
  }
};

// ─── server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  const handler = routes[key];
  if (!handler) return json(res, 404, { ok: false, error: `Route not found: ${key}` });
  try {
    await handler(req, res);
  } catch (e) {
    console.error(`[media-processor] Error on ${key}:`, e.message);
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[media-processor] ✅ Running on http://127.0.0.1:${PORT}`);
  console.log(`[media-processor] TMP_DIR: ${TMP_DIR}`);
  console.log(`[media-processor] FFmpeg: ${cp.execSync('ffmpeg -version 2>&1 | head -1').toString().trim()}`);
});

process.on('uncaughtException', e => console.error('[media-processor] uncaughtException:', e));
process.on('unhandledRejection', e => console.error('[media-processor] unhandledRejection:', e));
