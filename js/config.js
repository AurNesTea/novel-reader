/* 雲端設定：唯一需要手動填的地方。
   GOOGLE_CLIENT_ID 留空時，雲端硬碟登入與同步功能會停用（只顯示提示），本機匯入照常可用。
   用戶端 ID 不是密碼，放在公開 repo 沒問題；安全性由 Google Cloud Console 的「已授權的 JavaScript 來源」限制。 */
window.NOVEL_READER_CONFIG = window.NOVEL_READER_CONFIG || {
  GOOGLE_CLIENT_ID: '462040891132-qct9mi8bo7r7q12ies2jrmmqauknhhvk.apps.googleusercontent.com',
  DEFAULT_FOLDER_ID: '1GlJ8SygOp73V0tfFxaT_7pbO5BWc5Y4C'
};
