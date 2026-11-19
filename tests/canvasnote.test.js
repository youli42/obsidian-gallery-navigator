/* canvasnote.js 純函式的離線測試：檔名清洗與重名判斷（Windows 的大小寫與保留名）。
   執行：node tests/canvasnote.test.js */
const Module = require('module');
const path = require('path');
const assert = require('assert');

const SRC = process.argv[2] || path.join(__dirname, '..', 'src');
const obsidianStub = { TFile: class {}, Notice: class {}, Platform: { isMobile: false } };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return 'obsidian';
  return origResolve.call(this, request, ...rest);
};
require.cache.obsidian = { id: 'obsidian', filename: 'obsidian', loaded: true, exports: obsidianStub };

const { sanitize, uniquePath } = require(path.join(SRC, 'canvasnote.js'));

let n = 0;
const ok = (name) => { console.log('  ✓ ' + name); n++; };

// ── 檔名清洗 ──
{
  assert.strictEqual(sanitize('  a/b:c*d? "e"  '), 'abcd e');
  assert.strictEqual(sanitize('name.'), 'name', '結尾的點要去掉（Windows 不允許）');
  assert.strictEqual(sanitize('name .'), 'name');
  assert.strictEqual(sanitize('CON'), 'CON_', '裝置保留名要加後綴');
  assert.strictEqual(sanitize('nul'), 'nul_');
  assert.strictEqual(sanitize('COM1'), 'COM1_');
  assert.strictEqual(sanitize('console'), 'console', '只是剛好開頭像，不是保留名');
  ok('檔名清洗：非法字元、結尾點空白、Windows 保留名');
}

// ── 重名：大小寫不敏感、序號往後加 ──
{
  const folder = { path: 'notes', children: [{ name: 'Foo.md' }, { name: 'bar 2.md' }] };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === 'notes' ? folder : null),
      getRoot: () => ({ children: [] }),
    },
  };
  assert.strictEqual(uniquePath(app, 'notes', 'foo'), 'notes/foo 2.md',
    'Foo.md 已存在（大小寫不同）→ 不能直接用 foo.md');
  assert.strictEqual(uniquePath(app, 'notes', 'new'), 'notes/new.md');
  assert.strictEqual(uniquePath(app, 'notes', 'bar 2'), 'notes/bar 2 2.md');
  const rootApp = { vault: { getAbstractFileByPath: () => null, getRoot: () => ({ children: [{ name: 'x.md' }] }) } };
  assert.strictEqual(uniquePath(rootApp, '', 'x'), 'x 2.md', '根目錄也要比對');
  ok('重名：大小寫不敏感、序號遞增');
}

console.log(`\n${n} 項全過`);
