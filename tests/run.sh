#!/bin/bash
# 離線測試，不需要開 Obsidian。
#   bash tests/run.sh
# 排序測試用的是建置出來的 styles.css，所以改過 CSS 要先 npm run build。
# 排序測試需要 Python 版的 Playwright（pip install playwright && playwright install chromium）；
# 沒裝的話前三組照跑，最後一組會失敗。
cd "$(dirname "$0")/.." || exit 1
set -e
echo "== i18n（兩份字典的 key 一致、程式用到的字面 key 都有翻譯）"
node --no-warnings tests/i18n.test.js
echo "== 淨化連結（追蹤參數、&amp; 分隔符、Markdown 強調符號）"
node --no-warnings tests/cleanlink.test.js
echo "== Canvas 轉筆記（檔名清洗、大小寫重名）"
node --no-warnings tests/canvasnote.test.js
echo "== 連結卡快取（過期先顯示、背景重抓、Threads／IG 請求數、淘汰順序）"
node --no-warnings tests/linkcard-cache.test.js
echo "== 設定合併（三方合併的純函式）"
node --no-warnings tests/statesync.test.js
echo "== 兩台裝置共用 data.json（用外掛真正的存檔／拉取方法）"
node --no-warnings tests/plugin-state.test.js
echo "== 手機資料夾排序（無頭瀏覽器模擬觸控）"
python3 tests/reorder-harness.py
echo "== 手機點過之後 hover 不黏住、桌機 hover 還在"
python3 tests/hover-sticky.py
