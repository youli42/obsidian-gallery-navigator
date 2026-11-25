/* 共用：用 stub 的 obsidian 模組載入 gallery.js（照 plugin-state.test.js 的做法）。 */
const Module = require('module');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', 'src');

const klass = () => class { constructor() {} };
const obsidianStub = new Proxy({ Platform: { isMobile: false }, requestUrl: async () => ({ status: 404 }) }, {
  get(t, k) { if (k in t) return t[k]; if (/^[A-Z]/.test(String(k))) return (t[k] = klass()); return (t[k] = () => {}); },
});
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return 'obsidian';
  return origResolve.call(this, request, ...rest);
};
require.cache.obsidian = { id: 'obsidian', filename: 'obsidian', loaded: true, exports: obsidianStub };
global.window = global;
global.document = { body: { classList: { contains: () => false } }, visibilityState: 'visible' };
global.navigator = { language: 'zh-TW' };
const _warn = console.warn; console.warn = () => {};
const { GalleryPlugin, GalleryView } = require(path.join(SRC, 'gallery.js'));
console.warn = _warn;
const obsidian = require.cache.obsidian.exports;
const assert = require('assert');
let n = 0;
const ok = (name) => { console.log('  ✓ ' + name); n++; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/* ---- 新增檔案／資料夾後，只有「這面牆真的會變」才重畫 ---- */

function fakeFile(p, parentPath) {
  const f = new obsidian.TFile();
  f.path = p;
  f.parent = { path: parentPath };
  return f;
}
function fakeFolder(p) {
  const f = new obsidian.TFolder();
  f.path = p;
  f.children = [];
  return f;
}
function makeView({ cur = '', flatten = false, leftMode = 'folder', searchQ = '', hidden = false, entries = {} } = {}) {
  const view = Object.create(GalleryView.prototype);
  view.path = cur;
  view._searchQ = searchQ;
  view.plugin = { state: { flattenFolders: flatten, leftMode } };
  view.app = { vault: { getAbstractFileByPath: (p) => (p in entries ? entries[p] : null) } };
  view.contentEl = { clientWidth: hidden ? 0 : 640 };
  view.calls = [];
  view.render = () => view.calls.push('render');
  view.refreshTree = () => view.calls.push('refreshTree');
  return view;
}

(async () => {
  // ── 1. wallAffectedByCreate 的判斷 ──
  const entries = {
    'A/pic.png': fakeFile('A/pic.png', 'A'),
    'A/sub/x.md': fakeFile('A/sub/x.md', 'A/sub'),
    'B/y.png': fakeFile('B/y.png', 'B'),
    'root.md': fakeFile('root.md', '/'),
    'A/newfolder': fakeFolder('A/newfolder'),
  };

  // 目前在 A
  let v = makeView({ cur: 'A', entries });
  assert.strictEqual(v.wallAffectedByCreate('A/pic.png'), true, '目前資料夾的新檔 → 牆會變');
  assert.strictEqual(v.wallAffectedByCreate('B/y.png'), false, '別的資料夾的新檔 → 牆不變');
  assert.strictEqual(v.wallAffectedByCreate('A/sub/x.md'), false, '子資料夾（沒攤平）→ 牆不變');
  assert.strictEqual(v.wallAffectedByCreate('A/newfolder'), false, '新資料夾本身沒有卡片 → 牆不變');
  assert.strictEqual(v.wallAffectedByCreate('gone/x.png'), true, '檔案狀態不明 → 保守重畫');
  assert.strictEqual(v.wallAffectedByCreate(''), true, '空路徑 → 保守重畫');
  ok('一般資料夾：只認目前資料夾的新檔');

  // 攤平：子孫也算在牆上
  v = makeView({ cur: 'A', flatten: true, entries });
  assert.strictEqual(v.wallAffectedByCreate('A/sub/x.md'), true, '攤平 → 子資料夾的新檔也在牆上');
  assert.strictEqual(v.wallAffectedByCreate('B/y.png'), false, '攤平但不在子樹底下 → 不重畫');
  v = makeView({ cur: '', flatten: true, entries });
  assert.strictEqual(v.wallAffectedByCreate('root.md'), true, '根目錄新檔 → 牆會變');
  assert.strictEqual(v.wallAffectedByCreate('B/y.png'), true, '攤平＋根目錄 → 任何檔案都在牆上');
  ok('攤平模式：子孫資料夾的檔案也算在牆上');

  // 搜尋牆／標籤牆：任何新檔都可能命中
  assert.strictEqual(makeView({ cur: 'A', searchQ: 'foo', entries }).wallAffectedByCreate('B/y.png'), true, '搜尋中 → 保守重畫');
  assert.strictEqual(makeView({ cur: 'A', leftMode: 'tag', entries }).wallAffectedByCreate('B/y.png'), true, '標籤牆 → 保守重畫');
  ok('搜尋／標籤牆：保守重畫');

  // ── 2. refreshViewsAfterCreate 的批次分派 ──
  const visible = makeView({ cur: 'A', entries });
  const hiddenView = makeView({ cur: 'A', entries, hidden: true });
  const p = Object.create(GalleryPlugin.prototype);
  p.app = { workspace: { getLeavesOfType: () => [{ view: visible }, { view: hiddenView }] } };

  p.refreshViewsAfterCreate('B/y.png');       // 不在 A → 只更新左樹
  await tick(200);
  assert.deepStrictEqual(visible.calls, ['refreshTree'], '別的資料夾新增 → 只 refreshTree()');
  assert.strictEqual(hiddenView._needsRender, true, '看不見的畫廊 → 留旗標，不白做工');
  ok('在別的資料夾新增檔案 → 卡片牆不重畫');

  visible.calls.length = 0;
  p.refreshViewsAfterCreate('A/pic.png');     // 就在 A → 重畫
  await tick(200);
  assert.deepStrictEqual(visible.calls, ['render'], '目前資料夾新增 → render()');
  ok('在目前資料夾新增檔案 → 卡片牆重畫');

  // 同一批裡只要有一個落在牆上，就要重畫
  visible.calls.length = 0;
  p.refreshViewsAfterCreate('B/y.png');
  p.refreshViewsAfterCreate('B/z.png');
  p.refreshViewsAfterCreate('A/pic.png');
  await tick(200);
  assert.deepStrictEqual(visible.calls, ['render'], '批次裡有相關檔案 → 重畫一次');
  ok('同一批 create 合併判斷');

  console.log('新增檔案刷新：' + n + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
