/* 關分頁守衛的真值表：isAfterGalleryTabClose 決定要不要吞掉 file-open。
   這個判斷錯的兩個方向都有代價 —— 誤吞＝真正的導覽不定位，漏吞＝關掉圖片後目錄跳走。
   註：守衛放在 plugin 上、判定為「關閉餘波」時延後到下一個 tick 才清（多個畫廊視圖
   要看同一份判定），所以第 4/6 例必須跨 tick 檢查。
   執行：node tests/tabclose-guard.test.js */
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
const _warn = console.warn; console.warn = () => {};
const { GalleryView } = require(path.join(SRC, 'gallery.js'));
console.warn = _warn;
assert.ok(GalleryView, 'gallery.js 應匯出 GalleryView');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// 只帶守衛判斷需要的最小視圖：iterateAllLeaves 回傳的 leaf 清單完全由測試控制
function makeView(leaves = []) {
  const v = Object.create(GalleryView.prototype);
  v.plugin = { _lastOpenFromGallery: null, state: { syncActive: true } };
  v.app = { workspace: { iterateAllLeaves: (cb) => { for (const l of leaves) cb(l); } } };
  return v;
}
// 已載入的分頁 / 延遲載入的分頁（後者只有 viewState 有檔名）
const leafOf = (p) => ({ view: { file: { path: p } } });
const deferredLeafOf = (p) => ({ view: {}, getViewState: () => ({ state: { file: p } }) });
function guarded(v, p, leaf) {
  const rec = { path: p, leaf, owner: v };
  v.plugin._lastOpenFromGallery = rec;
  return rec;
}

(async () => {
  let n = 0;
  const ok = (name) => { console.log('  \u2713 ' + name); n++; };

  // 1. 沒有守衛 → 照常跟隨
  {
    const v = makeView();
    assert.strictEqual(v.isAfterGalleryTabClose({ path: 'b/note.md' }), false);
    ok('沒有守衛時照常跟隨');
  }

  // 2. file-open 就是剛才從畫廊開的那個檔 → 照常，守衛要留給之後的關閉
  {
    const v = makeView();
    guarded(v, 'img/a.png', leafOf('img/a.png'));
    const keep = v.plugin._lastOpenFromGallery;
    assert.strictEqual(v.isAfterGalleryTabClose({ path: 'img/a.png' }), false);
    assert.strictEqual(v.plugin._lastOpenFromGallery, keep, '自己被打開時守衛不該被清掉');
    ok('打開的就是剛才那個檔案 → 照常且守衛保留');
  }

  // 3. 分頁還在佈局裡（內容被換成別的檔）→ 使用者自己換檔，照常跟隨並清守衛
  {
    const imgLeaf = leafOf('img/a.png');
    const v = makeView([imgLeaf, leafOf('b/note.md')]);
    guarded(v, 'img/a.png', imgLeaf);
    assert.strictEqual(v.isAfterGalleryTabClose({ path: 'b/note.md' }), false);
    assert.strictEqual(v.plugin._lastOpenFromGallery, null);
    ok('分頁還在＝使用者自己換檔 → 照常跟隨');
  }

  // 4. 分頁已經關掉 → 吞掉事件，且同一個 tick 內第二個畫廊視圖也看得到守衛
  {
    const deadLeaf = leafOf('img/a.png');       // 不在 leaves 裡＝已 detach
    const v1 = makeView([]);
    const v2 = makeView([leafOf('b/note.md')]);
    v2.plugin = v1.plugin;                      // 兩個視圖共用 plugin 狀態
    const rec = guarded(v1, 'img/a.png', deadLeaf);
    assert.strictEqual(v1.isAfterGalleryTabClose({ path: 'b/note.md' }), true);
    assert.strictEqual(v2.isAfterGalleryTabClose({ path: 'b/note.md' }), true, '第二個視圖也要吞');
    assert.strictEqual(v1.plugin._lastOpenFromGallery, rec, '當下不清，留給同輪的其他視圖');
    await tick(10);
    assert.strictEqual(v1.plugin._lastOpenFromGallery, null, '下一輪要自動清掉，不能殘留');
    ok('關分頁的餘波 → 吞掉，且多視圖一致、下一輪自動清收');
  }

  // 5. 拿不到 leaf（原生開啟路徑）＋檔案還開在任何分頁 → 照常跟隨並清守衛
  {
    const v = makeView([deferredLeafOf('img/a.png')]);
    guarded(v, 'img/a.png', null);
    assert.strictEqual(v.isAfterGalleryTabClose({ path: 'b/note.md' }), false);
    assert.strictEqual(v.plugin._lastOpenFromGallery, null);
    ok('leaf 未知但檔案還開著（延遲載入分頁）→ 照常跟隨');
  }

  // 6. 拿不到 leaf ＋檔案已不在任何分頁 → 吞掉後自動清收
  {
    const v = makeView([leafOf('b/note.md')]);
    guarded(v, 'img/a.png', null);
    assert.strictEqual(v.isAfterGalleryTabClose({ path: 'b/note.md' }), true);
    await tick(10);
    assert.strictEqual(v.plugin._lastOpenFromGallery, null);
    ok('leaf 未知且檔案已全部關掉 → 吞掉並自動清收');
  }

  // 7. 兩個查詢各自的邊界
  {
    const alive = leafOf('x/a.md');
    const v = makeView([alive, deferredLeafOf('y/b.md')]);
    assert.strictEqual(v.isLeafAlive(alive), true);
    assert.strictEqual(v.isLeafAlive(leafOf('x/a.md')), false, '同路徑不同 leaf 不算活著');
    assert.strictEqual(v.isFileOpenInAnyLeaf('y/b.md'), true, '延遲載入分頁要看 viewState');
    assert.strictEqual(v.isFileOpenInAnyLeaf('z/c.md'), false);
    ok('isLeafAlive / isFileOpenInAnyLeaf 的邊界');
  }

  console.log(`\n${n} 項全過`);
})().catch((e) => { console.error(e); process.exit(1); });
