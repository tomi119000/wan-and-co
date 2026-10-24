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
  // ⚠️ 課金停止のため一時的に無効化しています（空 = 地図はLeaflet/無料、Places検索・写真・口コミ取得は停止）。
  //    再有効化するときは下記コメントのキーを GOOGLE_MAPS_API_KEY に戻してください。
  // 元のキー: "AIzaSyBYSrIit3f_fdb5-hf4ba8NGreEbY97RrI"
  GOOGLE_MAPS_API_KEY: "",

  /* ---------------------------------------------------------
     Google Places API (New) — 施設情報の取得専用（地図表示は無料のOSMのまま）
     ・保存するのは place_id と位置（30日以内に更新）だけ。店名などは表示時に取得
     ・下の PLACES_BUDGET（月間回数）に達すると、アプリが自動で呼び出しを止める
       （各SKUの無料枠より少なめに設定 → 通常は ¥0）
     ・空文字にすると Google 連携を完全停止
     --------------------------------------------------------- */
  GOOGLE_PLACES_API_KEY: "AIzaSyBYSrIit3f_fdb5-hf4ba8NGreEbY97RrI",
  PLACES_BUDGET: {
    textPro: 4000,      // Text Search Pro（無料 5,000/月）
    textEnt: 900,       // Text Search Enterprise：月次更新で公式サイトURLも受け取る（無料 1,000/月）
    detailsPro: 4000,   // Place Details Pro：店名・住所（無料 5,000/月）
    detailsAtmos: 800,  // Place Details Enterprise+Atmosphere：電話・口コミ・犬同伴可など（無料 1,000/月）
    photo: 800,         // Place Photos（無料 1,000/月）
  },
  // 管理者（Google施設インデックスの月次更新ができる人）。アプリのログインメールアドレス
  ADMIN_EMAILS: ["tomi119000@gmail.com"],

  // OpenStreetMap 由来のスポットを表示するか。false でも assets/osm-data.json と
  // Firestore 上のデータは残る（true に戻せば再表示）
  SHOW_OSM_DATA: false,
  // アプリ作成時の初期サンプル4件（青山テラス ドッグカフェ等）を表示するか。false でもデータは残る
  SHOW_SAMPLE_DATA: false,

  // 地図の初期表示位置（東京・中心部）
  DEFAULT_CENTER: { lat: 35.6720, lng: 139.7100 },
  DEFAULT_ZOOM: 13,
  // マップ画面を開いたときに表示する範囲（中心からの半径・メートル）
  INITIAL_RADIUS_M: 500,

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
