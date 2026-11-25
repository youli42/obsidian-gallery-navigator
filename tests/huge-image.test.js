/* 大圖不退回原圖的判定（2026-11-25 記憶體修正）＋縮圖佇列的大檔獨佔。 */
const Module = require('module');
const path = require('path');
const assert = require('assert');
const SRC = process.argv[2] || path.join(__dirname, '..', 'src');

const klass = () => class { constructor() {} };
const obsidianStub = new Proxy({ Platform: { isMobile: false } }, {
  get(t, k) { if (k in t) return t[k]; if (/^[A-Z]/.test(String(k))) return (t[k] = klass()); return (t[k] = () => {}); },
});
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return 'obsidian';
  return origResolve.call(this, request, ...rest);
};
require.cache.obsidian = { id: 'obsidian', filename: 'obsidian', loaded: true, exports: obsidianStub };
global.window = global;
global.document = { body: { classList: { contains: () => false } } };
global.navigator = { language: 'zh-TW' };

const { ThumbCache, isHugeImage, isHeavyDecode } = require(path.join(SRC, 'thumbs.js'));
let n = 0;
const ok = (name) => { console.log('  ✓ ' + name); n++; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const file = (bytes, p = 'x.png') => ({ path: p, stat: { size: bytes } });

(async () => {
  // ── isHugeImage：檔案大小與長寬比都是判準 ──
  assert.strictEqual(isHugeImage(file(300 * 1024), [800, 600]), false, '小檔小圖 → 可以退回原圖');
  assert.strictEqual(isHugeImage(file(300 * 1024), [4000, 3000]), true, '小檔大圖（高壓縮 JPEG）→ 不可退回');
  assert.strictEqual(isHugeImage(file(2 * 1024 * 1024), null), true, '大檔（尺寸未知）→ 不可退回');
  assert.strictEqual(isHugeImage(file(500 * 1024), null), false, '小檔（尺寸未知）→ 可以退回');
  assert.strictEqual(isHugeImage(null, null), false, '沒有檔案 → 交給呼叫端');
  assert.strictEqual(isHugeImage(file(300 * 1024), [2000, 1000]), false, '剛好 2000px 不算大圖');
  ok('isHugeImage 判定（大小／長寬比）');

  // ── isHeavyDecode：決定「要不要獨佔解碼」的是點陣圖大小，不是檔案大小 ──
  assert.strictEqual(isHeavyDecode(file(20 * 1024 * 1024), [1000, 800]), false, '尺寸小 → 不獨佔（即使檔案很大）');
  assert.strictEqual(isHeavyDecode(file(300 * 1024), [4000, 4000]), true, '解碼後 64MB → 獨佔');
  assert.strictEqual(isHeavyDecode(file(9 * 1024 * 1024), null), true, '尺寸未知 → 用檔案大小當退路');
  assert.strictEqual(isHeavyDecode(file(1024 * 1024), null), false, '尺寸未知且檔案小 → 不獨佔');
  ok('isHeavyDecode 判定（點陣圖大小優先）');

  // ── 縮圖佇列：大檔不能兩張同時解碼 ──
  const cache = new ThumbCache({ app: {}, manifest: { dir: '' } });
  cache.concurrency = 2;
  let largeRunning = 0, maxLarge = 0, running = 0, maxRunning = 0;
  cache._make = async (f) => {
    const large = f.stat.size >= 8 * 1024 * 1024;
    running++; if (running > maxRunning) maxRunning = running;
    if (large) { largeRunning++; if (largeRunning > maxLarge) maxLarge = largeRunning; }
    await tick(30);
    running--; if (large) largeRunning--;
    return null;
  };
  cache.queue = [
    { file: file(10 * 1024, 'small1.png'), cbs: [] },
    { file: file(10 * 1024, 'small2.png'), cbs: [] },
    { file: file(20 * 1024 * 1024, 'big1.png'), cbs: [] },
    { file: file(20 * 1024 * 1024, 'big2.png'), cbs: [] },
  ];
  cache._pump();
  await tick(250);
  assert.strictEqual(maxLarge, 1, '兩張大圖不能同時解碼（實測峰值就是這樣疊出來的）');
  assert.ok(maxRunning >= 1, '至少有一張在跑');
  ok('縮圖佇列：大檔獨佔（同時最多 1 張大圖）');

  console.log('大圖記憶體防護：' + n + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
