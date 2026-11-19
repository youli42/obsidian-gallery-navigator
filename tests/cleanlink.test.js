/* cleanlink.js 純函式的離線測試：追蹤參數淨化的邊界（Markdown 強調符號、&amp; 分隔符）。
   執行：node tests/cleanlink.test.js */
const Module = require('module');
const path = require('path');
const assert = require('assert');

const SRC = process.argv[2] || path.join(__dirname, '..', 'src');

const obsidianStub = {
  Notice: class {}, Setting: class {},
  requestUrl: async () => ({ status: 200, text: '' }),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return 'obsidian';
  return origResolve.call(this, request, ...rest);
};
require.cache.obsidian = { id: 'obsidian', filename: 'obsidian', loaded: true, exports: obsidianStub };

const { cleanUrl, cleanText } = require(path.join(SRC, 'cleanlink.js'));

let n = 0;
const ok = (name) => { console.log('  ✓ ' + name); n++; };
const clean = (s, opt) => cleanText(s, opt).text;

// ── cleanUrl：基本刪除與保留 ──
{
  assert.strictEqual(cleanUrl('https://a.com/x?utm_source=1&id=2'), 'https://a.com/x?id=2');
  assert.strictEqual(cleanUrl('https://a.com/x?id=2'), 'https://a.com/x?id=2', '沒有追蹤碼要原樣回傳');
  assert.strictEqual(cleanUrl('https://a.com/x?utm_source=1#sec'), 'https://a.com/x#sec', 'hash 要保留');
  assert.strictEqual(cleanUrl('https://a.com/x'), 'https://a.com/x');
  ok('刪掉追蹤參數、保留其餘參數與 hash');
}

// ── cleanUrl：HTML 轉義的 &amp; 分隔符 ──
{
  assert.strictEqual(cleanUrl('https://a.com/x?utm_source=1&amp;fbclid=2'), 'https://a.com/x',
    '兩個追蹤參數都被刪掉，且不能留下 "?&amp;" 殘骸');
  assert.strictEqual(cleanUrl('https://a.com/x?utm_source=1&amp;id=2'), 'https://a.com/x?id=2',
    '刪掉第一個參數後，第二個不該帶著 &amp; 變成 "?&amp;id=2"');
  assert.strictEqual(cleanUrl('https://a.com/x?u=1&amp;utm_source=2&amp;v=3'), 'https://a.com/x?u=1&amp;v=3',
    '中間的參數被刪掉時，&amp; 分隔符要原樣保留');
  ok('&amp; 當分隔符時不會改壞網址');
}

// ── cleanText：Markdown 強調符號不能被吃掉 ──
{
  assert.strictEqual(clean('~~https://a.com/x?utm_source=1~~'), '~~https://a.com/x~~', '刪除線');
  assert.strictEqual(clean('**https://a.com/x?utm_source=1**'), '**https://a.com/x**', '粗體');
  assert.strictEqual(clean('__https://a.com/x?utm_source=1__'), '__https://a.com/x__', '粗體（底線）');
  assert.strictEqual(clean('_https://a.com/x?utm_source=1_'), '_https://a.com/x_', '斜體（底線）');
  assert.strictEqual(clean('看 *https://a.com/x?fbclid=1* 這篇'), '看 *https://a.com/x* 這篇', '斜體');
  // 前面沒有開符號時，網址結尾的底線是網址的一部分，不能剝掉
  assert.strictEqual(clean('https://a.com/x_y?utm_source=1'), 'https://a.com/x_y', '結尾底線屬於網址');
  ok('Markdown 強調符號成對保留');
}

// ── cleanText：內文與標點不被誤刪 ──
{
  assert.strictEqual(clean('請看 https://a.com/x?fbclid=1，這篇很好'), '請看 https://a.com/x，這篇很好');
  assert.strictEqual(clean('(https://a.com/x?utm_source=1)'), '(https://a.com/x)');
  assert.strictEqual(clean('沒有網址的一段文字'), '沒有網址的一段文字');
  const r = cleanText('a https://a.com/x?utm_source=1 b https://b.com/y?utm_source=2');
  assert.strictEqual(r.count, 2, 'count 要算到 2 條');
  ok('中文標點、括號、多條網址');
}

// ── 補充黑名單與「通用名稱只在特定網域才算追蹤碼」──
{
  for (const [url, want] of [
    ['https://a.com/x?mkt_tok=abc', 'https://a.com/x'],
    ['https://a.com/x?_kx=abc', 'https://a.com/x'],
    ['https://a.com/x?ef_id=abc', 'https://a.com/x'],
    ['https://a.com/x?s_kwcid=abc', 'https://a.com/x'],
    ['https://a.com/x?spm=a1z.2', 'https://a.com/x'],
    ['https://docs.example.com/d?share_token=abc', 'https://docs.example.com/d'],
  ]) assert.strictEqual(cleanUrl(url), want, url);
  // 通用名：Amazon 才砍，其他站保留（免得誤刪功能參數）
  assert.strictEqual(cleanUrl('https://www.amazon.com/dp/X?psc=1&tag=t-20'), 'https://www.amazon.com/dp/X');
  assert.strictEqual(cleanUrl('https://example.com/doc?psc=2&awc=3'), 'https://example.com/doc?psc=2&awc=3');
  ok('补充追踪参数；psc／awc 只在 Amazon 生效');
}

// ── 使用者自訂保留名單優先於黑名單 ──
{
  const opt = { state: { cleanLinkKeep: 'utm_source' } };
  assert.strictEqual(cleanUrl('https://a.com/x?utm_source=1&fbclid=2', opt), 'https://a.com/x?utm_source=1');
  ok('保留名單優先');
}

console.log(`\n${n} 項全過`);
