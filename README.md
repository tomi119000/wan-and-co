# Wan & Co. 🐾 — 愛犬と行ける上質なスポットを共有するWeb App

都心の高所得・40代以上の愛犬家をターゲットにした、犬同伴可能な飲食店・宿泊施設・公園などを
**検索・登録・共有・保存**できるレスポンシブWebアプリです。
Firebase による全ユーザー共有と、Google Maps / Places API 連携に対応しています。

- 公開URL: https://tomi119000.github.io/wan-and-co/
- ホスティング: GitHub Pages（静的配信）
- バックエンド: Firebase Authentication + Cloud Firestore
- 地図: Google Maps JavaScript API（キー未設定時は Leaflet + OpenStreetMap に自動フォールバック）

---

## 1. 画面構成（複数ページ・下部ナビで遷移）

| ファイル | 画面 | 主な機能 |
|---|---|---|
| `index.html` | ログイン | メール＋パスワード認証。ゲスト体験ボタンあり |
| `signup.html` | 新規登録 | アカウント作成 |
| `map.html` | マップ（ホーム） | 地図・現在地・カテゴリ絞り込み・**エリア検索(Places)**・表示範囲連動の「近くのスポット」 |
| `list.html` | スポット一覧 | 登録済み全スポットの検索・カテゴリ絞り込み |
| `place.html` | スポット詳細 | 写真・地図・チェックイン・アプリ内口コミ・**Google口コミ**・保存 |
| `add.html` | スポット登録 | 写真アップロード・地図で位置指定・公開/非公開 |
| `saved.html` | 保存（お気に入り） | ♡で保存したスポットの一覧 |
| `mypage.html` | マイページ | プロフィール・実績・自分の登録スポットの公開切替/削除 |

下部ナビ: **マップ / スポット / 登録(＋) / 保存(♥) / マイページ**

---

## 2. 機能仕様

### 2.1 認証
- メールアドレス＋パスワードでの新規登録・ログイン・ログアウト（Firebase Authentication）
- 各ページはログイン必須（未ログインは `index.html` へリダイレクト）
- 「ゲストとして体験する」で共有デモアカウントに即ログイン

### 2.2 地図
- 現在地取得（📍ボタン）
- カテゴリ絞り込みチップ（すべて / カフェ・飲食 / 宿泊 / 公園 / ショップ / その他）
- スポットはカスタムのゴールドのピンで表示、タップで情報ウィンドウ→詳細へ
- 「近くのスポット」リストは**地図の表示範囲内（＝ピンが見える範囲）の施設だけ**を表示し、
  地図を動かすとリストも追従する

### 2.3 Places API によるエリア検索と自動保存（API節約）
- 「🔍 このエリアの犬同伴スポットを探す」で、表示中エリアの実在する犬同伴スポットを
  Google Places API (New) の Text Search で取得（ドッグカフェ / ドッグラン / ペット可 等の複合クエリ）
- **検索結果は自動的に Firestore に永続保存**され、全ユーザーで共有される
  - 重複は `place_id` ベースで自動スキップ
  - 以降そのエリアは**ボタンを押さなくても（＝APIを使わずに）**地図・一覧に表示される
  - 写真・概要も保存するため、再表示時の追加API呼び出しも不要
- 施設写真は Places の Photo、概要は editorialSummary を取得して表示

### 2.4 スポット詳細
- ヒーロー写真・カテゴリ・住所・評価/チェックイン/口コミ数
- **チェックイン**（1日1回・重複防止、チェックイン数を集計表示）
- **アプリ内口コミ**（★評価＋コメント、投稿者・相対日時つき）
- **Googleの口コミ**（実在スポットのみ）：
  - ワンちゃん関連（犬・愛犬・ペット・同伴・dog 等）の口コミを**優先表示**（🐾マーク）
  - **投稿年月日**を表示（例：2026年4月2日）
- **♡ 保存する**ボタン

### 2.5 スポット登録（ユーザー投稿）
- 施設名・カテゴリ・住所・紹介文
- 写真アップロード（複数可・クライアント側で縮小圧縮）
- 地図タップ or 現在地で位置指定
- 公開／非公開の選択

### 2.6 保存（お気に入り）
- マップ・スポット一覧の各カード、および詳細ページの ♡ ボタンで保存/解除
- 保存データはユーザーに紐づいて Firestore に保存 → **どの端末からでも同じ保存リスト**
- 「保存」ページで一覧・詳細確認・解除
- 検索で見つけた未登録スポットを保存した場合は、自動でDBに取り込んでから保存

### 2.7 マイページ
- プロフィール、実績（登録スポット数・チェックイン数・投稿口コミ数）
- 自分が登録したスポットの公開/非公開切替・削除

### 2.8 モバイル最適化・デザイン
- チャコール×シャンパンゴールド、明朝体見出しの高級感デザイン
- 大きなタップ領域（40代以上に配慮）
- スマホで初期表示時に検索ボタンが見えるよう地図の高さを調整
- スクロール可能とわかる「▾ 下にスクロールで一覧」ヒント（初回スクロールで消える）

---

## 3. データモデル（Cloud Firestore）

```
places/{placeId}
  source: "google" | "user" | "places"   // seed / ユーザー投稿 / Places取込
  ownerId, ownerName, placeId(Google), name, category, address, desc
  lat, lng, visibility: "public"|"private"
  cover(写真URL), checkinCount, reviewCount, ratingSum, createdAt
  ├─ reviews/{id}   : userId, userName, rating, text, at
  ├─ photos/{id}    : url, at
  └─ checkins/{uid_YYYY-MM-DD} : userId, userName, at   // ID で1日1回を担保

users/{uid}
  name, email, placeCount, checkinCount, reviewCount, joined
  savedIds: [placeId, ...]   // お気に入り

meta/seeded_v1   // 初期シード投入済みマーカー
```

- 評価平均 = `ratingSum / reviewCount`
- チェックイン/口コミ数は集計フィールドとして施設ドキュメントに保持（ルールで加算のみ許可）

---

## 4. アーキテクチャ

- **`assets/data.js`** — データ層。`Auth` と `Store` を **Firebase / localStorage の二層**で同一の
  非同期APIとして公開。`config.js` に Firebase 設定があれば Firebase、無ければ localStorage を自動選択。
  各ページはバックエンドを意識しない。
- **`assets/maps.js`** — 地図ラッパー `WCMap`。Google Maps と Leaflet を同一API
  (`create / addMarker / setView / onClick / setYou / inBounds / onIdle` ほか) で切替。
  Places 検索 `searchDogFriendly`、写真 `fetchPhoto`、口コミ `fetchReviews` を提供（Google時のみ）。
  取得結果はセッション内キャッシュ。
- **`assets/app.js`** — UIヘルパー（DOM/トースト/カード生成/カテゴリ/保存ボタン配線/下部ナビ）。
- **`assets/config.js`** — Google Maps キーと Firebase 設定。
- 写真は Storage 課金を避けるため、クライアント側で縮小圧縮し dataURL / Places の Photo URL で保持。

---

## 5. セットアップ

### 5.1 ローカル実行
```bash
cd wan-and-co
python3 -m http.server 8000
# → http://localhost:8000/
```
`file://` では位置情報や一部機能が制限されるため、必ずローカルサーバー経由で開く。

### 5.2 Firebase（全ユーザー共有）
1. [Firebase コンソール](https://console.firebase.google.com/)でプロジェクト作成
2. Authentication → メール/パスワードを有効化
3. Firestore Database を作成
4. Firestore ルールに [`firestore.rules`](firestore.rules) を貼り付けて公開
5. Authentication → Settings → 承認済みドメインに公開ドメイン（例 `tomi119000.github.io`）を追加
6. プロジェクト設定 → ウェブアプリ(</>) の `firebaseConfig` を [`assets/config.js`](assets/config.js) の `firebase:` に貼り付け

### 5.3 Google Maps / Places API
1. [Google Cloud Console](https://console.cloud.google.com/google/maps-apis) で
   **Maps JavaScript API** と **Places API (New)** を有効化
2. APIキーを作成し、[`assets/config.js`](assets/config.js) の `GOOGLE_MAPS_API_KEY` に設定
3. キーに**アプリケーション制限（HTTPリファラー）**を設定：
   - `https://tomi119000.github.io/*`
   - `http://localhost:8000/*`

---

## 6. 運用・コスト・セキュリティ

- **APIコスト管理**
  - Google Cloud → お支払い → 予算とアラートで月予算＋メール通知
  - Google Maps Platform → Quotas で 1日あたり上限（Maps: Map loads / Places: SearchTextRequest 等）
  - 検索結果の自動保存により、同じエリアの再検索が減り API 使用量を抑制
- **セキュリティ**
  - 公開リポジトリのため、Google Maps キーはリファラー制限で保護
  - Firebase の apiKey は公開前提（クライアントキー）。データ保護は [`firestore.rules`](firestore.rules) が担う

### デプロイ（GitHub Pages）
```bash
git add -A && git commit -m "..." && git push
```
- HTML は各アセットを `?v=YYYYMMDDx` 付きで読み込む（キャッシュバスティング）。
  更新をデプロイする際は全HTMLの `?v=` を上げると、利用者の端末に自動で最新版が反映される。

---

## 7. 実装済み要件チェックリスト

- ✅ メール/パスワード認証（新規登録・ログイン）
- ✅ Google Maps 連携（現在地・スポット位置・地図タップで位置登録）
- ✅ Google（Places API）掲載の犬同伴施設を表示、コメント可
- ✅ Places API で実在スポットを検索し **自動でDB保存・全ユーザー共有**
- ✅ ★評価つきアプリ内口コミ／**Google口コミ（ワンちゃん優先・日付つき）**
- ✅ ユーザーによる施設登録（写真・コメント）
- ✅ 公開／非公開の切替
- ✅ チェックイン機能＋数表示
- ✅ お気に入り保存（♡）と保存ページ
- ✅ 施設写真・概要の自動取得表示、カード説明文
- ✅ 表示範囲に連動した「近くのスポット」
- ✅ スマホ最適化（地図高さ・スクロールヒント）＋高級感デザイン＋大きなタップ領域

---

## 8. 今後の拡張候補

- **地理クエリによる範囲読み込み**：現在はマップ表示時に公開スポットを全件読み込む。
  データが数千件規模になったら、表示エリア付近だけを読み込む方式（geohash 等）へ移行する。
- Firebase Storage への写真移行（大量・高解像度運用時）
- 保存/口コミのプライバシー設定強化、通報・モデレーション
- Google口コミのDBキャッシュ（詳細再表示時の Place Details 呼び出し削減）
