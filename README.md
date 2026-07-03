# Wan & Co. 🐾 — 愛犬と行ける上質なスポットを共有するWeb App

都心の高所得・40代以上の愛犬家をターゲットにした、犬同伴可能な飲食店・宿泊施設・公園などを
登録・共有できるレスポンシブWebアプリのデモです。すべてブラウザ内（localStorage）で完結します。

## 画面構成（複数ページ・ボタン遷移）

| ファイル | 画面 | 主な機能 |
|---|---|---|
| `index.html` | ログイン | ID(メール)＋パスワード。ゲスト体験ボタンあり |
| `signup.html` | 新規登録 | アカウント作成 |
| `map.html` | マップ（ホーム） | 地図表示・現在地取得・カテゴリ絞り込み・近くのスポット一覧 |
| `list.html` | スポット一覧 | 検索・カテゴリ絞り込み |
| `place.html` | スポット詳細 | 写真・地図・**チェックイン**・**口コミ投稿** |
| `add.html` | スポット登録 | 写真アップロード・地図で位置指定・公開/非公開設定 |
| `mypage.html` | マイページ | プロフィール・実績・自分の登録スポットの公開切替/削除 |

下部のナビゲーションバーで全画面を行き来できます。

## 実装済みの要件

- ✅ ID/パスワードのログイン・新規登録
- ✅ 地図連携（現在地・スポット位置の確認、地図タップで位置登録）
- ✅ 「Google Mapに登録済み」施設をデフォルト表示（`source: "google"` のシードデータ）し、コメント可
- ✅ 地図上の施設への口コミ（★評価つき）
- ✅ 地図にない施設をユーザーが自分で登録
- ✅ 登録時に写真・コメントをアップロード／入力
- ✅ 登録場所の公開／非公開切替
- ✅ チェックイン機能＋チェックイン数表示
- ✅ 他ユーザーが施設へ口コミ追加
- ✅ スマホ最適化のレスポンシブ・高級感デザイン・大きなタップ領域（40代以上配慮）

## 起動方法

ローカルサーバー経由で開いてください（`file://` だと位置情報や一部機能が制限されます）。

```bash
cd wan-and-co
python3 -m http.server 8000
# → ブラウザで http://localhost:8000/ を開く
```

## Google Maps API について（実装済み）

地図は **Google Maps JavaScript API** に対応済みです。キーを設定すると自動的に Google Maps へ、
未設定のあいだはローカルで動く **Leaflet + OpenStreetMap** へ自動フォールバックします（デモがオフラインでも動く仕組み）。

**Google Maps を有効にする手順:**

1. [Google Maps Platform](https://console.cloud.google.com/google/maps-apis) で **Maps JavaScript API** を有効化し、API キーを取得
   （既存施設の自動取得まで行う場合は **Places API** も有効化）
2. `assets/config.js` を開き、キーを貼り付けるだけ:
   ```js
   window.WC_CONFIG = { GOOGLE_MAPS_API_KEY: "AIzaSy...あなたのキー" , ... };
   ```
3. リロードすると、マップ・詳細・登録画面のすべてが Google Maps に切り替わります。

地図処理は `assets/maps.js` の `WCMap` ラッパーに集約されており、
Google Maps / Leaflet を同一 API（`create / addMarker / setView / onClick / setYou`）で扱えます。
各ページ（`map.html` / `place.html` / `add.html`）はこのラッパー経由なので、プロバイダ差を意識せず動きます。

## みんなで共有（Firebase 連携）— 実装済み

認証とデータを **Firebase Authentication + Cloud Firestore** に対応済みです。
`config.js` に Firebase 設定を入れると、全ユーザーが同じデータ（登録スポット・口コミ・チェックイン）を
共有する本番モードに切り替わります。未設定なら従来通り端末内(localStorage)で動作します。

### セットアップ手順

1. [Firebase コンソール](https://console.firebase.google.com/) で **プロジェクトを作成**
2. **Authentication** → Sign-in method →「**メール/パスワード**」を有効化
3. **Firestore Database** → データベースを作成（本番モードでOK）
4. **Firestore のルール** に [`firestore.rules`](firestore.rules) の内容を貼り付けて公開
5. プロジェクト設定 → マイアプリ →「**</>**（ウェブ）」でアプリを追加し、表示された
   `firebaseConfig` を [`assets/config.js`](assets/config.js) の `firebase:` に貼り付け
6. リロードすると共有モードに切替（初回ログイン時に既存施設4件が自動投入されます）

### 設計（データ層）

- すべてのデータ操作は [`assets/data.js`](assets/data.js) の `Auth` / `Store` に集約。
  Firebase と localStorage を**同じ非同期API**で扱えるため、各ページはバックエンドを意識しません。
- 写真は Storage 課金を避けるため、クライアント側で縮小圧縮して Firestore に保存します
  （大量・高解像度運用時は Firebase Storage への移行を推奨）。
- 既存施設（Google Map掲載）は `source: "google"` のシードデータ。将来 Places API に置換可能。

> ⚠️ このリポジトリは公開です。`config.js` に実キーを入れて push する場合は、Google Maps キーに
> HTTPリファラー制限を、Firebase には上記 `firestore.rules` によるアクセス制限を必ず設定してください。
