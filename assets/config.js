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

  /* ---------------------------------------------------------
     Firebase 連携（「みんなで共有」を有効にする）
     -----------------------------------------------------------
     Firebase コンソールで Web アプリを登録すると表示される
     firebaseConfig をここに貼り付けてください。
     apiKey が空のあいだは、これまで通り端末内(localStorage)で
     動作します（＝データは共有されません）。

     ▼ 取得方法:
       https://console.firebase.google.com/
       1. プロジェクトを作成
       2. Authentication → Sign-in method →「メール/パスワード」を有効化
       3. Firestore Database → データベースを作成（本番/ロックモードでOK・後でルール設定）
       4. プロジェクトの設定 → マイアプリ →「</>」でWebアプリを追加
          → 表示される firebaseConfig の中身を下にコピー
     --------------------------------------------------------- */
  firebase: {
    apiKey: "AIzaSyCG9rOBHbnWSuv4HEQor5Vz6Ab4hfMc-Us",
    authDomain: "wan-and-co.firebaseapp.com",
    projectId: "wan-and-co",
    storageBucket: "wan-and-co.firebasestorage.app",
    messagingSenderId: "510249838033",
    appId: "1:510249838033:web:064d02eff33f67bdf22cf0",
  },
};
