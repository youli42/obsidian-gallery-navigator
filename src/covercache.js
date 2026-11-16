'use strict';

/* ===== 卡片封面落盤快取（2026-11-16）=====
 *
 * 放的是「由來源檔生成、隨時可以重建的卡片封面圖」：
 *   • Excalidraw 繪圖縮圖（.excalidraw.md / .excalidraw）
 *   • 影片首幀（mp4 / mov / webm…，見 videocover.js）
 *   • 之後要加別的（PDF 首頁快照、網頁截圖…）也丟這裡：同一個目錄、同一份配額。
 * 影格圖存 .jpg、繪圖縮圖存 .png/.svg，檔名是「來源路徑的 hash + 副檔名」，
 * 同一個來源路徑只會屬於其中一種，不會互撞。
 *
 * 為什麼要落盤：以前這些縮圖只存在記憶體（dataURL 字串），重啟 Obsidian、
 * 捲回第 41 張、圖被改過 → 全部重跑一次生成（繪圖單張中位數 58ms、大圖 250ms，
 * 全在主執行緒；影片還要整檔讀進來重新解碼）。落盤之後第二次進同一個資料夾就是讀檔。
 *
 * 三個設計重點：
 *   1. **預算是位元組，不是張數**（見 budgetBytes）。張數上限對「大圖小圖混在一起」
 *      完全沒有保護力。超預算時砍最久沒被用的（LRU，靠索引裡的 at 時間戳）。
 *   2. **單張太大就不落盤**（超過預算 1/4）。否則一張 1.2MB 的大圖會擠掉幾十張小圖，
 *      反而讓命中率變差。
 *   3. **索引壞掉就當作空**。縮圖是純快取，任何異常都只是重做一次，不值得為了
 *      還原它去冒險（thumbs.js 的 prune 註解有同樣的取捨）。
 *
 * ⚠️ 配額是所有封面共用一份（設定頁「封面快取」）：影片首幀不會因為「另一種東西」
 *    而繞過預算。呼叫端在 set() 回 null 時要接受「這張卡沒有封面」，不要另外退回
 *    內嵌 dataURL——那等於繞過配額，幾十張卡就能吃掉幾 MB 常駐記憶體。
 *    （唯一的例外是 Excalidraw 的退回：見 gallery.js 的 renderXcalThumb，磁碟寫不進去時
 *      仍留一份 dataURL 在記憶體，否則整面牆會少一張圖；那條路有 XCAL_THUMB_MAX 上限。）
 */

const DEFAULT_MB_DESKTOP = 200;   // 200 MB：480px 縮圖約 30–100KB、影片首幀約 50–150KB，夠幾千張
const DEFAULT_MB_MOBILE = 50;     // 50 MB：手機磁碟小、也很少一次翻大資料夾
const MIN_MB = 10;
const MAX_MB = 2000;
const SINGLE_MAX_RATIO = 0.25;    // 單張不得超過預算的 1/4

/* 檔名用的 hash（與 thumbs.js 同一套 cyrb53 風格雙 32-bit，等效 64-bit）。
   ⚠️ 這裡刻意重複一份而不是從 thumbs.js 匯出：兩者檔案路徑不同、生命週期不同，
      共用一個匯出反而讓「改 thumb 的命名」有機會弄壞這份既有快取。 */
function hash64(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

class CoverCache {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    /* index: 檔案路徑 → [檔名, mtime, bytes, at]
       mtime 不符＝來源檔被改過，視為沒有（會重做並覆蓋）。
       at 是最後一次命中的時間戳，只用來做 LRU 淘汰。 */
    this.index = {};
    this.used = 0;
    this._saveT = 0;
    this._dirty = 0;
    this._ready = false;
    this._loadOk = false;
    this._loadP = null;
  }

  dir() { return this.plugin.manifest.dir + '/cover-cache'; }
  indexPath() { return this.dir() + '/index.json'; }

  /** 這台裝置的快取預算（位元組）。設定值非法就退回預設。 */
  budgetBytes() {
    const raw = Number(this.plugin.state && this.plugin.state.coverCacheMB);
    const mobile = document.body.classList.contains('is-mobile');
    const mb = Number.isFinite(raw) && raw > 0 ? raw : (mobile ? DEFAULT_MB_MOBILE : DEFAULT_MB_DESKTOP);
    return Math.round(Math.min(MAX_MB, Math.max(MIN_MB, mb)) * 1024 * 1024);
  }

  /** 讀索引（只做一次；並行呼叫共用同一個 promise） */
  ensure() {
    if (this._ready) return Promise.resolve();
    if (this._loadP) return this._loadP;
    this._loadP = (async () => {
      try {
        const a = this.app.vault.adapter;
        if (await a.exists(this.indexPath())) {
          const raw = JSON.parse(await a.read(this.indexPath())) || {};
          for (const p of Object.keys(raw)) {
            const rec = raw[p];
            if (!Array.isArray(rec) || !rec[0]) continue;
            const bytes = Number(rec[2]) || 0;
            this.index[p] = [String(rec[0]), Number(rec[1]) || 0, bytes, Number(rec[3]) || 0];
            this.used += bytes;
          }
          this._loadOk = true;
        } else {
          this._loadOk = true;      // 檔案不存在＝正常的第一次
        }
      } catch (e) {
        this.index = {};
        this.used = 0;
        this._loadOk = false;       // 解析失敗：不准 prune（見 prune 的防線②）
      }
      this._ready = true;
    })();
    return this._loadP;
  }

  /** 有可用的落盤封面 → 回傳資源路徑；mtime 不符或沒有 → null */
  urlFor(file) {
    const rec = this.index[file.path];
    if (!rec || rec[1] !== file.stat.mtime) return null;
    const a = this.app.vault.adapter;
    /* 檔案可能被使用者（或第三方清理工具）手動刪掉，索引卻還在。
       這裡不驗存在性：getResourcePath 給的網址由瀏覽器去讀，讀不到會走 <img> 的
       error，不影響正確性；驗一次要 await，會拖到卡片繪製路徑。 */
    rec[3] = Date.now();
    this.save();
    try { return a.getResourcePath(this.dir() + '/' + rec[0]); } catch (e) { return null; }
  }

  /** 寫入一張封面。成功回傳資源路徑；超過單張上限或寫入失敗 → null（呼叫端維持原卡樣） */
  async set(file, bytes, ext) {
    await this.ensure();
    const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    const size = (buf && buf.byteLength) || 0;
    if (!size) return null;
    if (size > this.budgetBytes() * SINGLE_MAX_RATIO) return null;   // ③ 單張太大：不落盤
    try {
      const a = this.app.vault.adapter;
      const dir = this.dir();
      if (!(await a.exists(dir))) await a.mkdir(dir);
      /* 同一路徑重做時檔名通常不變（hash 只吃路徑），只有 png↔jpg／svg 這種會換副檔名。
         先把舊的一筆從帳上扣掉，再按新檔寫入，used 才不會重複累加。 */
      const old = this.index[file.path];
      if (old) {
        this.used -= old[2] || 0;
        if (old[0] !== hash64(file.path) + '.' + (ext || 'png')) {
          try { await a.remove(dir + '/' + old[0]); } catch (e) {}
        }
        delete this.index[file.path];
      }
      const fname = hash64(file.path) + '.' + (ext || 'png');
      await a.writeBinary(dir + '/' + fname, buf);
      this.index[file.path] = [fname, file.stat.mtime, size, Date.now()];
      this.used += size;
      this._evict();
      this.save();
      return a.getResourcePath(dir + '/' + fname);
    } catch (e) {
      return null;
    }
  }

  /* 超過預算 → 砍最久沒被用到的（LRU）。同步版本：只改索引，刪檔在背景跑。
     ⚠️ 不能用「插入順序」當 LRU：Map/物件的鍵順序跟使用頻率無關，
        逛一圈新資料夾就會把最常看的那幾張擠掉。 */
  _evict() {
    const budget = this.budgetBytes();
    if (this.used <= budget) return;
    const entries = Object.keys(this.index)
      .map((p) => ({ p, at: this.index[p][3] || 0, bytes: this.index[p][2] || 0 }))
      .sort((x, y) => x.at - y.at);
    const doomed = [];
    for (const e of entries) {
      if (this.used <= budget) break;
      this.used -= e.bytes;
      doomed.push(this.index[e.p][0]);
      delete this.index[e.p];
    }
    if (!doomed.length) return;
    this.save();
    void (async () => {
      const a = this.app.vault.adapter;
      for (const fname of doomed) {
        try { await a.remove(this.dir() + '/' + fname); } catch (e) {}
      }
    })();
  }

  /* 這個路徑本身與它下面所有子路徑的索引鍵。
     ⚠️ 資料夾被刪除／改名時，傳進來的是資料夾路徑，只處理「完全相等」那一筆
        會把整個子樹的封面留成永久孤兒（要等使用者手動清快取才會消失）。 */
  _keysUnder(path) {
    const prefix = path + '/';
    return Object.keys(this.index).filter((k) => k === path || k.startsWith(prefix));
  }

  /** 來源檔被刪除（或整個資料夾被刪）→ 連磁碟檔一起清掉 */
  async forget(path) {
    await this.ensure();
    const keys = this._keysUnder(path);
    if (!keys.length) return;
    const a = this.app.vault.adapter;
    const doomed = [];
    for (const k of keys) {
      doomed.push(this.index[k][0]);
      this.used -= this.index[k][2] || 0;
      delete this.index[k];
    }
    this.save();
    for (const fname of doomed) {
      try { await a.remove(this.dir() + '/' + fname); } catch (e) {}
    }
  }

  /** 改名／搬移（含整個資料夾）→ 檔名是路徑的 hash，只能讀出來重寫一份。
      少見操作，值得這個成本；做不動就讓它下次重做，不影響正確性。 */
  async rename(newPath, oldPath) {
    await this.ensure();
    const keys = this._keysUnder(oldPath);
    if (!keys.length) return;
    const a = this.app.vault.adapter;
    for (const k of keys) {
      const rec = this.index[k];
      const nk = newPath + k.slice(oldPath.length);
      this.used -= rec[2] || 0;
      delete this.index[k];
      try {
        const src = this.dir() + '/' + rec[0];
        const data = await a.readBinary(src);
        const ext = rec[0].slice(rec[0].lastIndexOf('.') + 1);
        const fname = hash64(nk) + '.' + ext;
        await a.writeBinary(this.dir() + '/' + fname, new Uint8Array(data));
        try { await a.remove(src); } catch (e) {}
        this.index[nk] = [fname, rec[1], rec[2], Date.now()];
        this.used += rec[2] || 0;
      } catch (e) {
        /* 這筆搬不動 → 就當作沒快取，下次生成時重建 */
      }
    }
    this.save();
  }

  /* 清掉「來源已不存在」與「超出預算」的項目，回傳刪掉的張數。
     四道防線照 pruneOgCache 的教訓：索引沒載入成功就什麼都不做，
     否則一掃就把整個資料夾刪光。 */
  async prune() {
    await this.ensure();
    if (!this._loadOk) return 0;
    const a = this.app.vault.adapter;
    let removed = 0;
    for (const p of Object.keys(this.index)) {
      if (this.app.vault.getAbstractFileByPath(p)) continue;
      try { await a.remove(this.dir() + '/' + this.index[p][0]); } catch (e) {}
      this.used -= this.index[p][2] || 0;
      delete this.index[p];
      removed++;
    }
    const before = Object.keys(this.index).length;
    this._evict();
    removed += before - Object.keys(this.index).length;
    /* 孤兒檔（索引裡沒有的檔案）：只在索引確實可信時才動手。
       多留一份孤兒只是佔空間；刪錯一張要重新生成，兩害相權取其輕。 */
    try {
      if (await a.exists(this.dir())) {
        const list = await a.list(this.dir());
        const known = new Set(Object.keys(this.index).map((p) => this.index[p][0]));
        for (const f of (list.files || [])) {
          const name = f.split('/').pop();
          if (!name || name === 'index.json' || known.has(name)) continue;
          try { await a.remove(f); removed++; } catch (e) {}
        }
      }
    } catch (e) {}
    if (removed) this.save();
    return removed;
  }

  /** 設定頁「清除封面快取」：整個目錄清空（不是只清失效的） */
  async clearAll() {
    await this.ensure();
    const a = this.app.vault.adapter;
    const n = Object.keys(this.index).length;
    this.index = {};
    this.used = 0;
    this.save();
    try {
      const dir = this.dir();
      if (await a.exists(dir)) {
        const list = await a.list(dir);
        for (const f of (list.files || [])) {
          try { await a.remove(f); } catch (e) {}
        }
      }
    } catch (e) {}
    return n;
  }

  usage() { return this.used; }

  save() {
    this._dirty = 1;
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => { void this._write(); }, 1500);
  }

  async _write() {
    this._dirty = 0;
    try {
      const a = this.app.vault.adapter;
      const dir = this.dir();
      if (!(await a.exists(dir))) await a.mkdir(dir);
      await a.write(this.indexPath(), JSON.stringify(this.index));
    } catch (e) {}
  }

  /* 未落地的索引立刻寫出（onunload 用）。
     ⚠️ 少了這一步：封面檔已在磁碟、索引還卡在 1.5s 去抖窗裡就被停用 → 下次啟動
        整批重做，舊檔全成孤兒（thumbs.js 同一個坑）。 */
  async flush() {
    if (this._saveT) { clearTimeout(this._saveT); this._saveT = 0; }
    if (this._dirty) await this._write();
  }
}

module.exports = { CoverCache, DEFAULT_MB_DESKTOP, DEFAULT_MB_MOBILE, MIN_MB, MAX_MB };
