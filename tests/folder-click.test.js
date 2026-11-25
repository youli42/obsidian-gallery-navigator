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

/* ---- 資料夾列：點一下展開／再點同一個收合，且不重畫卡片牆 ---- */

function makeView({ path = 'A', expanded = ['A'], searchQ = '', searchOn = false } = {}) {
  const view = Object.create(GalleryView.prototype);
  view.path = path;
  view._searchQ = searchQ;
  view._searchOn = searchOn;
  view.selFolders = new Set();
  view.folderSelMode = false;
  view.folderReorderMode = false;
  view.plugin = {
    state: { expandedFolders: expanded.slice(), lastPath: path },
    saves: 0,
    saveState() { this.saves++; },
  };
  view.calls = [];
  view.refreshTree = () => view.calls.push('refreshTree');
  view.render = () => view.calls.push('render');
  view.clearSearchState = () => view.calls.push('clearSearch');
  view.resetCardFilters = () => view.calls.push('resetFilters');
  view.gotoCardsMobile = () => view.calls.push('gotoMobile');
  view.toggleFolderSel = (p) => view.calls.push('toggleSel:' + p);
  view.rangeFolderSel = (a, p) => view.calls.push('rangeSel:' + p);
  view.clearFolderSel = () => { view.selFolders.clear(); view.calls.push('clearFolderSel'); };
  return view;
}
const folder = (p) => ({ path: p, name: p.split('/').pop() });

(async () => {
  // 1. 收合的資料夾 → 點一下：展開 + 切過去（卡片牆要重畫）
  let v = makeView({ path: 'A', expanded: [] });
  v.clickFolderRow(folder('B'), true, {});
  assert.deepStrictEqual(v.plugin.state.expandedFolders, ['B'], '點收合的資料夾要展開');
  assert.strictEqual(v.path, 'B', '點別的資料夾要切過去');
  assert.strictEqual(v.plugin.state.lastPath, 'B', 'lastPath 要跟著換');
  assert.ok(v.calls.includes('render'), '切換資料夾要重畫卡片牆');
  ok('點收合的資料夾 → 展開並切過去');

  // 2. 同一個資料夾（已展開）→ 再點：收合，卡片牆不重畫
  v = makeView({ path: 'A', expanded: ['A'] });
  v.clickFolderRow(folder('A'), true, {});
  assert.deepStrictEqual(v.plugin.state.expandedFolders, [], '同一個資料夾再點一次要收合');
  assert.deepStrictEqual(v.calls, ['refreshTree'], '只重畫左樹，不要 render()');
  assert.strictEqual(v.path, 'A', '路徑不變');
  ok('再點同一個資料夾 → 收合，卡片牆不刷新');

  // 3. 同一個資料夾（已收合）→ 再點：展開，一樣不重畫卡片牆
  v = makeView({ path: 'A', expanded: [] });
  v.clickFolderRow(folder('A'), true, {});
  assert.deepStrictEqual(v.plugin.state.expandedFolders, ['A'], '要展開');
  assert.deepStrictEqual(v.calls, ['refreshTree'], '不要 render()');
  ok('收合的目前資料夾再點一次 → 展開，不刷新卡片牆');

  // 4. 沒有子資料夾的列：開合狀態不動，仍然只重畫左樹
  v = makeView({ path: 'A', expanded: ['A'] });
  v.clickFolderRow(folder('A'), false, {});
  assert.deepStrictEqual(v.plugin.state.expandedFolders, ['A'], '沒有小孩不该改 expandedFolders');
  assert.deepStrictEqual(v.calls, ['refreshTree']);
  ok('沒有子資料夾的列 → 不動開合狀態');

  // 5. 搜尋中點目前資料夾：要離開搜尋並重畫
  v = makeView({ path: 'A', expanded: ['A'], searchQ: 'foo' });
  v.clickFolderRow(folder('A'), true, {});
  assert.ok(v.calls.includes('render'), '搜尋中要重畫');
  assert.ok(v.calls.includes('clearSearch'), '要離開搜尋狀態');
  ok('搜尋中點目前資料夾 → 重畫並離開搜尋');

  // 6. 多選（修飾鍵）優先：不導覽、不開合
  v = makeView({ path: 'A', expanded: [] });
  v.clickFolderRow(folder('B'), true, { ctrlKey: true, preventDefault() {} });
  assert.deepStrictEqual(v.calls, ['toggleSel:B']);
  assert.deepStrictEqual(v.plugin.state.expandedFolders, []);
  ok('Ctrl/Cmd 點 → 多選，不導覽');

  // 7. 排序模式：什麼都不做（手指在把手附近放開不算點列）
  v = makeView({ path: 'A', expanded: [] });
  v.folderReorderMode = true;
  v.clickFolderRow(folder('B'), true, { preventDefault() {} });
  assert.deepStrictEqual(v.calls, []);
  assert.deepStrictEqual(v.plugin.state.expandedFolders, []);
  ok('排序模式 → 點列不做事');

  console.log('資料夾點擊：' + n + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
