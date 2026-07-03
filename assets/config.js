/* ===========================================================
   Wan & Co. — configuration
   -----------------------------------------------------------
   本番で Google Maps を使う場合は、下記に API キーを貼り付けてください。
   キーが空のあいだは、ローカルで動くフォールバック地図
   (Leaflet + OpenStreetMap) が自動的に使われます。

   ▼ Google Maps Platform でキーを取得:
     https://console.cloud.google.com/google/maps-apis
     - "Maps JavaScript API" を有効化
     - 必要に応じて "Places API"（既存施設の取得）も有効化
   =========================================================== */
window.WC_CONFIG = {
  // 例: "AIzaSyD-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  GOOGLE_MAPS_API_KEY: "",

  // 地図の初期表示位置（東京・中心部）
  DEFAULT_CENTER: { lat: 35.6720, lng: 139.7100 },
  DEFAULT_ZOOM: 13,
};
