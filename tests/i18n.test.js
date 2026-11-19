/* i18n 兩份字典的鍵集合必須一致，且程式裡每個字面 t('…') 都要查得到。
   漏掉的 key 不會壞掉，只會讓中文介面默默顯示英文 —— 靠測試擋住。
   執行：node tests/i18n.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || path.join(__dirname, '..', 'src');
const { DICTS } = require(path.join(SRC, 'i18n.js'));

let n = 0;
const ok = (name) => { console.log('  ✓ ' + name); n++; };

const LANGS = Object.keys(DICTS);
const tw = DICTS['zh-TW'];
const cn = DICTS['zh-CN'];

// ── 1. 兩份字典的 key 完全一致 ──
{
  const onlyTw = Object.keys(tw).filter((k) => !(k in cn));
  const onlyCn = Object.keys(cn).filter((k) => !(k in tw));
  assert.deepStrictEqual(onlyTw, [], 'zh-TW 有、zh-CN 沒有的 key：' + onlyTw.join(' / '));
  assert.deepStrictEqual(onlyCn, [], 'zh-CN 有、zh-TW 沒有的 key：' + onlyCn.join(' / '));
  ok(`兩份字典 key 數一致（${Object.keys(tw).length}）`);
}

// ── 2. 沒有空字串翻譯 ──
{
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(DICTS[lang])) {
      assert.ok(typeof v === 'string' && v.trim(), `${lang} 的「${k}」翻譯是空的`);
      // 變數佔位符兩邊都要留著，否則 t() 的變數注入會失效
      const vars = k.match(/\{\{\w+\}\}/g) || [];
      for (const v2 of vars) assert.ok(v.includes(v2), `${lang} 的「${k}」少了佔位符 ${v2}`);
    }
  }
  ok('沒有空翻譯，佔位符都保留');
}

// ── 3. 程式裡的字面 key 都存在於兩份字典 ──
{
  const srcFiles = fs.readdirSync(SRC).filter((f) => /\.(js|ts)$/.test(f));
  const unesc = (s) => s.replace(/\\(['"\\])/g, '$1');
  const used = new Map();
  for (const f of srcFiles) {
    /* 先剝掉註解：i18n.js 的說明段落裡就有 t('Search notes') 這種範例，
       不剝的話會誤報成「少了一條翻譯」。 */
    const s = fs.readFileSync(path.join(SRC, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const re = /\bt\(\s*'((?:[^'\\]|\\.)*)'|\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(s))) {
      const raw = m[1] !== undefined ? m[1] : m[2];
      // 動態拼出來的 key（t(n + ' column')）與範例里的 t('key') 略過
      if (!raw || raw.includes('${') || /^\s*$/.test(raw)) continue;
      const key = unesc(raw).replace(/\s+/g, ' ').trim();
      if (!used.has(key)) used.set(key, new Set());
      used.get(key).add(f);
    }
  }
  const missing = [];
  for (const [key, files] of used) {
    if (!(key in tw)) missing.push(`zh-TW 缺「${key}」← ${[...files].join(',')}`);
  }
  assert.deepStrictEqual(missing, [], 't() 用到但字典沒有的 key：\n' + missing.join('\n'));
  ok(`程式裡的 ${used.size} 個字面 key 都有翻譯`);
}

console.log(`\n${n} 項全過`);
