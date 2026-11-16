'use strict';

/* ===== 影片封面（2026-11-16）=====
 *
 * 影片檔（mp4/mov/webm…）在卡片牆上原本只有檔型圖示卡。封面有兩條來源：
 *   1. 同名封面圖：clip.mp4 旁的 clip.cover.jpg／clip.jpg（零解碼、跨裝置穩定）
 *      → 由 gallery.js 的 coverFor() 直接當一般圖片卡處理，不進這裡、也不佔快取配額。
 *   2. 抽首幀（本檔的 grabVideoFrame）：用 <video> 解碼第一格畫面，轉成 JPEG。
 *      結果由 gallery.js 寫進共用的封面快取（cover-cache/，與 Excalidraw 縮圖同一個配額）。
 *
 * ⚠️ 抽首幀為什麼一定要走 Blob URL，不能直接把資源路徑塞給 <video>：
 *    卡片牆拿到的資源路徑長這樣：app://<隨機權杖>/<vault 絕對路徑>/…
 *    對 canvas 而言那是**跨來源**資源，drawImage 之後 canvas 會被污染（tainted），
 *    接著 toBlob / toDataURL 直接拋 SecurityError。
 *    vault.readBinary → Blob → URL.createObjectURL 給的是**同源** blob:，
 *    canvas 不會被污染，也不需要替影片檔處理任何 CORS。
 *    代價是整個檔案要讀進記憶體一次（Obsidian 的 adapter 沒有範圍讀取），
 *    所以只對「裝置上限」以下的影片這樣做；更大的維持圖示卡。
 *
 * ⚠️ 容器支援度（Chromium／Obsidian 內建）：
 *    mp4 / m4v / mov / webm 正常；mkv 多半可以解出畫面（音訊不一定）；
 *    avi / ogv 很容易完全解不出來 → 解碼失敗就靜默退回圖示卡（不要重試）。
 */

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;

/* 同名封面圖的搜尋順序：明確的 .cover.* 先，再來直接同名。
   ⚠️ 同名圖有可能是本來就存在的插圖（例如簡報截圖和影片同名），
      所以 .cover.* 這種「一看就知道是封面」的寫法優先。 */
const SIBLING_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'];

/* 讀整檔解碼的上限（2026-11-16）：readBinary 的 buffer 與 Blob／解碼中的畫格會同時存在，
   記憶體峰值大約是檔案大小的兩倍。手機（iOS WebView）記憶體緊、太大會被系統直接砍掉，
   所以預設值分兩套：桌機 120MB、手機 30MB。
   ⚠️ 使用者的設定值在設定頁（gallery.js 的 videoCoverMaxMB），這裡只是「沒設定時」的預設。 */
const MAX_SOURCE_MB_DESKTOP = 120;
const MAX_SOURCE_MB_MOBILE = 30;
const FRAME_MAX_W = 640;                       // 卡片最寬約 400 CSS px，640 夠 2 倍螢幕
const FRAME_QUALITY = 0.82;                    // 與 thumbs.js 的縮圖品質一致
const FRAME_AT = 2;                            // 目標秒數（會被片長壓縮，見 frameTime）
const DECODE_TIMEOUT = 10000;

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
};

function isVideoFile(f) {
  return !!(f && VIDEO_EXT.test(f.path));
}

/** 這個檔案的封面圖（同目錄、同名或 .cover 後綴）→ 資源路徑或 null。
    路徑比較便宜：最多 12 次 getAbstractFileByPath，且結果由 coverFor 的 mtime 快取接住。 */
function videoSiblingCover(app, file) {
  if (!isVideoFile(file)) return null;
  const dot = file.path.lastIndexOf('.');
  if (dot < 0) return null;
  const base = file.path.slice(0, dot);
  for (const suffix of ['.cover', '']) {
    for (const ext of SIBLING_EXTS) {
      const f = app.vault.getAbstractFileByPath(base + suffix + ext);
      if (f && f.stat) {
        try { return app.vault.getResourcePath(f); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/** 這台裝置的預設讀檔上限（bytes）。 */
function deviceMaxSourceBytes() {
  const mb = document.body.classList.contains('is-mobile') ? MAX_SOURCE_MB_MOBILE : MAX_SOURCE_MB_DESKTOP;
  return mb * 1024 * 1024;
}

/** 值不值得抽首幀（影片 + 大小在裝置上限內）。太大就維持圖示卡。 */
function shouldGrabVideoFrame(file) {
  if (!isVideoFile(file)) return false;
  const size = (file.stat && file.stat.size) || 0;
  return size > 0 && size <= deviceMaxSourceBytes();
}

/** 只等一個事件（含 error 與逾時），成功 resolve、否則 reject。 */
function waitEvent(el, name, ms) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      el.removeEventListener(name, ok);
      el.removeEventListener('error', bad);
    };
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(name + ':error')); };
    timer = setTimeout(() => { cleanup(); reject(new Error(name + ':timeout')); }, ms);
    el.addEventListener(name, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

/* 抓哪一秒：片頭常常是全黑或 logo，抓太早等於沒有封面。
   2 秒對長片剛好；短片（<20 秒）用片長的 10%，避免短片的 2 秒已經快播完。 */
function frameTime(duration) {
  const d = Number.isFinite(duration) ? duration : 0;
  if (d <= 0) return 0;
  return Math.min(FRAME_AT, Math.max(0.1, d * 0.1));
}

/* 這一格是不是幾乎全黑（片頭淡入／黑場）。抽樣 8×8 就夠判斷，
   不必逐像素——這裡只是決定「要不要再換一個時間點抓一次」。 */
function nearlyBlack(ctx, w, h) {
  try {
    const sw = Math.max(1, Math.min(8, w));
    const sh = Math.max(1, Math.min(8, h));
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const cx = c.getContext('2d');
    cx.drawImage(ctx.canvas, 0, 0, sw, sh);
    const data = cx.getImageData(0, 0, sw, sh).data;
    c.width = 0; c.height = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    return sum / (data.length / 4) / 3 < 14;   // 平均亮度 < 14/255
  } catch (e) {
    return false;   // 讀不到就當作不是黑幀（不重試、不影響出圖）
  }
}

/**
 * 抽一張首幀。
 * @returns {Promise<{bytes: Uint8Array, width: number, height: number}|null>}
 *   失敗（容器不支援、解碼逾時、尺寸為 0…）一律回 null，呼叫端維持圖示卡。
 */
async function grabVideoFrame(app, file, opt) {
  const opts = opt || {};
  if (!shouldGrabVideoFrame(file)) return null;

  const ext = (file.extension || '').toLowerCase();
  const type = MIME_BY_EXT[ext] || '';
  const buf = await app.vault.readBinary(file);
  const blob = new Blob([buf], { type });
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';

  try {
    v.src = url;
    await waitEvent(v, 'loadeddata', opts.timeout || DECODE_TIMEOUT);

    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const at = frameTime(dur);
    if (at > 0) {
      try {
        v.currentTime = at;
        await waitEvent(v, 'seeked', 6000);
      } catch (e) {
        /* seek 不了（片段索引缺失、直播封裝…）→ 就用目前解碼到的這一格 */
      }
    }

    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (!w || !h) return null;

    const cw = Math.max(1, Math.min(FRAME_MAX_W, w));
    const ch = Math.max(1, Math.round(h * (cw / w)));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(v, 0, 0, cw, ch);

    /* 片頭黑場：換到片長 30%（最多 10 秒）再抓一次。只重試一次。 */
    if (dur > 6 && nearlyBlack(ctx, cw, ch)) {
      try {
        v.currentTime = Math.min(dur * 0.3, 10);
        await waitEvent(v, 'seeked', 6000);
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(v, 0, 0, cw, ch);
      } catch (e) { /* 重試失敗就用第一格（黑畫面至少還是封面） */ }
    }

    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', FRAME_QUALITY));
    // 大 canvas 是 cw*ch*4 bytes，畫完立刻歸零，不等 GC
    canvas.width = 0;
    canvas.height = 0;
    if (!out) return null;
    return { bytes: new Uint8Array(await out.arrayBuffer()), width: cw, height: ch };
  } finally {
    try { v.pause(); } catch (e) {}
    try { v.removeAttribute('src'); v.load(); } catch (e) {}
    URL.revokeObjectURL(url);
  }
}

module.exports = {
  VIDEO_EXT,
  isVideoFile,
  videoSiblingCover,
  shouldGrabVideoFrame,
  grabVideoFrame,
  MAX_SOURCE_MB_DESKTOP,
  MAX_SOURCE_MB_MOBILE,
};
