/* ===========================================================
   Wan & Co. — Google Places API (New) 連携（規約準拠・低コスト）
   -----------------------------------------------------------
   ・保存するのは place_id と位置（30日以内に再取得）だけ。
     店名・住所・電話・写真・口コミは「表示するとき」に取得する。
   ・すべての呼び出しを月間予算（config.PLACES_BUDGET）で制限。
     予算の残りが無ければ呼ばない（＝無料枠を超えない）。
   ・取得内容はタブを閉じるまでの一時キャッシュ（sessionStorage）のみ。

   公開 API: window.GPlaces
     enabled                         キーが設定されているか
     WARDS / QUERIES                 対象区・カテゴリ別検索語
     wardByName(name)
     searchCategory(cat, ward)       区×カテゴリのライブ検索（1語=1回, 最大20件）
     details(pid, "basic"|"full")    施設情報（basic=店名/住所, full=電話/口コミ/犬同伴可等）
     photoUrl(photoName)             写真URL（1枚=1回）
     loadIndex()                     月次インデックス（place_id+位置）。30日超は無効
     collect({wards, onLog})         【管理者】月次インデックス更新
     usage()                         今月の利用回数と予算
     mapsLink(pid, name)             Google マップで開くURL（無料・API不使用）
   =========================================================== */
(function () {
  const cfg = window.WC_CONFIG || {};
  const KEY = (cfg.GOOGLE_PLACES_API_KEY || "").trim();
  const BUDGET = Object.assign({ textPro: 4000, textEnt: 900, detailsPro: 4000, detailsAtmos: 800, photo: 800 }, cfg.PLACES_BUDGET || {});
  const API = "https://places.googleapis.com/v1";
  const INDEX_MAX_AGE_DAYS = 30; // 位置情報のキャッシュ上限（Google 規約）

  /* 第1弾の対象エリア（都心の区）。locationRestriction 用の概略矩形 */
  const WARDS = [
    { name: "港区",     low: [35.625, 139.712], high: [35.682, 139.775] },
    { name: "渋谷区",   low: [35.645, 139.661], high: [35.693, 139.719] },
    { name: "目黒区",   low: [35.604, 139.661], high: [35.646, 139.717] },
    { name: "文京区",   low: [35.700, 139.722], high: [35.737, 139.772] },
    { name: "世田谷区", low: [35.598, 139.582], high: [35.683, 139.694] },
    { name: "千代田区", low: [35.668, 139.728], high: [35.705, 139.783] },
    { name: "中央区",   low: [35.647, 139.763], high: [35.698, 139.800] },
    { name: "新宿区",   low: [35.680, 139.674], high: [35.725, 139.748] },
    { name: "品川区",   low: [35.584, 139.700], high: [35.635, 139.765] },
  ];

  /* アプリのカテゴリ → Google で検索する語 */
  const QUERIES = {
    cafe:    ["ドッグカフェ", "犬同伴 レストラン"],
    clinic:  ["動物病院"],
    park:    ["ドッグラン"],
    salon:   ["トリミングサロン", "出張トリミング"],
    school:  ["ドッグトレーニング", "犬の幼稚園"],
    daycare: ["ペットホテル"],
    hotel:   ["犬と泊まれる ホテル"],
    care:    ["老犬ホーム"],
  };

  const ym = () => { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0"); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ss = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  async function fdb() {
    if (window.Data && Data.ready) await Data.ready();
    return (window.Data && Data.mode === "firebase" && window.firebase) ? firebase.firestore() : null;
  }

  /* ---------- 予算（月間回数）の予約。許可された回数を返す ---------- */
  async function reserve(sku, n) {
    n = n || 1;
    const d = await fdb();
    if (!d) {
      const k = "wc_usage_" + ym();
      const u = JSON.parse(localStorage.getItem(k) || "{}"), cur = u[sku] || 0;
      const allow = Math.max(0, Math.min(n, BUDGET[sku] - cur));
      if (allow) { u[sku] = cur + allow; localStorage.setItem(k, JSON.stringify(u)); }
      return allow;
    }
    const ref = d.collection("usage").doc(ym());
    try {
      return await d.runTransaction(async tx => {
        const s = await tx.get(ref);
        const cur = (s.exists && s.data()[sku]) || 0;
        const allow = Math.max(0, Math.min(n, BUDGET[sku] - cur));
        if (allow) tx.set(ref, { [sku]: cur + allow }, { merge: true });
        return allow;
      });
    } catch (e) { return 0; } // 確認できないときは安全側（呼ばない）
  }

  async function usage() {
    const d = await fdb();
    let counts = {};
    if (!d) counts = JSON.parse(localStorage.getItem("wc_usage_" + ym()) || "{}");
    else { try { const s = await d.collection("usage").doc(ym()).get(); counts = s.exists ? s.data() : {}; } catch (e) {} }
    return { month: ym(), counts, budget: BUDGET };
  }

  async function call(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
    return j;
  }

  const norm = p => ({
    pid: p.id, name: (p.displayName && p.displayName.text) || "", address: p.formattedAddress || "",
    lat: p.location ? p.location.latitude : null, lng: p.location ? p.location.longitude : null,
    types: p.types || [], primaryType: p.primaryType || "", mapsUri: p.googleMapsUri || "",
    website: p.websiteUri || "",
  });
  // 住所の表記ゆれに強い区名判定（"日本、〒153-0063 東京都目黒区…" 等）
  const inWard = (addr, ward) => !ward || String(addr || "").includes(ward.name);

  /* ---------- Text Search（Pro 区分のみの項目に限定） ---------- */
  const SEARCH_MASK = "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.googleMapsUri,nextPageToken";
  // 月次更新でのみ使用：websiteUri を含むため Text Search Enterprise 区分（無料 1,000回/月）
  const SEARCH_MASK_WEB = SEARCH_MASK + ",places.websiteUri";

  async function searchText(textQuery, ward, pageToken, noCache, withWeb) {
    const ck = "gp:s:" + textQuery + "|" + (ward ? ward.name : "") + "|" + (pageToken || "");
    if (!noCache) { const c = ss.get(ck); if (c) return c; }
    if (!KEY) return { places: [], next: null, blocked: "nokey" };
    if (!(await reserve(withWeb ? "textEnt" : "textPro"))) return { places: [], next: null, blocked: "budget" };
    const body = { textQuery, languageCode: "ja", regionCode: "JP", pageSize: 20 };
    if (ward) body.locationRestriction = { rectangle: {
      low: { latitude: ward.low[0], longitude: ward.low[1] },
      high: { latitude: ward.high[0], longitude: ward.high[1] } } };
    if (pageToken) body.pageToken = pageToken;
    const j = await call(API + "/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": withWeb ? SEARCH_MASK_WEB : SEARCH_MASK },
      body: JSON.stringify(body),
    });
    const out = { places: (j.places || []).map(norm).filter(p => inWard(p.address, ward)), next: j.nextPageToken || null };
    if (!noCache) ss.set(ck, out);
    return out;
  }

  /* 区×カテゴリ（そのカテゴリの検索語ぶん。各1ページ=最大20件） */
  async function searchCategory(cat, ward) {
    const qs = QUERIES[cat] || [];
    const seen = new Map(); let blocked = null;
    for (const q of qs) {
      try {
        const r = await searchText(q + " " + ward.name, ward);
        if (r.blocked) blocked = r.blocked;
        r.places.forEach(p => { if (!seen.has(p.pid)) seen.set(p.pid, Object.assign(p, { category: cat })); });
      } catch (e) { blocked = blocked || "error:" + e.message; }
    }
    return { places: [...seen.values()], blocked };
  }

  /* ---------- Place Details ---------- */
  const BASIC_MASK = "id,displayName,formattedAddress,location,types,primaryType,googleMapsUri";
  const FULL_MASK = BASIC_MASK + ",nationalPhoneNumber,websiteUri,rating,userRatingCount,regularOpeningHours,allowsDogs,reviews,photos";
  const DOG_RE = /犬|いぬ|イヌ|わんこ|わんちゃん|ワンちゃん|ワンコ|愛犬|ペット|同伴|ドッグ|dog|puppy|pet/i;

  async function details(pid, level) {
    level = level === "full" ? "full" : "basic";
    const ck = "gp:d:" + pid + ":" + level;
    const c = ss.get(ck); if (c) return c;
    if (level === "basic") { const f = ss.get("gp:d:" + pid + ":full"); if (f) return f; }
    if (!KEY) return { blocked: "nokey" };
    if (!(await reserve(level === "full" ? "detailsAtmos" : "detailsPro"))) return { blocked: "budget" };
    const j = await call(API + "/places/" + encodeURIComponent(pid) + "?languageCode=ja&regionCode=JP", {
      headers: { "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": level === "full" ? FULL_MASK : BASIC_MASK },
    });
    const d = norm(j);
    if (level === "full") {
      Object.assign(d, {
        phone: j.nationalPhoneNumber || "", website: j.websiteUri || "",
        rating: j.rating || null, ratingCount: j.userRatingCount || 0,
        hours: (j.regularOpeningHours && j.regularOpeningHours.weekdayDescriptions) || [],
        allowsDogs: (j.allowsDogs === undefined) ? null : j.allowsDogs,
        photos: (j.photos || []).slice(0, 3).map(ph => ({
          name: ph.name, attrs: (ph.authorAttributions || []).map(a => a.displayName).filter(Boolean) })),
        reviews: (j.reviews || []).map(r => {
          const text = (r.text && r.text.text) || (r.originalText && r.originalText.text) || "";
          return {
            author: (r.authorAttribution && r.authorAttribution.displayName) || "Google ユーザー",
            authorUri: (r.authorAttribution && r.authorAttribution.uri) || "",
            rating: r.rating || 0, text,
            dateMs: r.publishTime ? new Date(r.publishTime).getTime() : 0,
            rel: r.relativePublishTimeDescription || "", dog: DOG_RE.test(text),
          };
        }).sort((a, b) => (b.dog - a.dog) || (b.dateMs - a.dateMs)),
      });
    }
    ss.set(ck, d);
    return d;
  }

  /* 写真：1枚ごとに Place Photos を1回。リダイレクトせず photoUri を受け取りセッション内で再利用 */
  async function photoUrl(photoName, maxPx) {
    if (!photoName) return "";
    const ck = "gp:p:" + photoName; const c = ss.get(ck); if (c) return c;
    if (!KEY || !(await reserve("photo"))) return "";
    try {
      const j = await call(API + "/" + photoName + "/media?maxWidthPx=" + (maxPx || 1000) + "&skipHttpRedirect=true", {
        headers: { "X-Goog-Api-Key": KEY },
      });
      const u = j.photoUri || ""; ss.set(ck, u); return u;
    } catch (e) { return ""; }
  }

  /* ---------- 月次インデックス（place_id + 位置 + 自社分類） ---------- */
  let indexCache = null;
  async function loadIndex() {
    if (indexCache) return indexCache;
    const d = await fdb();
    let data = null;
    try {
      if (d) { const s = await d.collection("meta").doc("googlePlaces").get(); data = s.exists ? s.data() : null; }
      else data = JSON.parse(localStorage.getItem("wc_gindex") || "null");
    } catch (e) { data = null; }
    const ts = data && data.updatedAt ? (data.updatedAt.toMillis ? data.updatedAt.toMillis() : data.updatedAt) : 0;
    const ageDays = ts ? (Date.now() - ts) / 864e5 : Infinity;
    const fresh = ageDays <= INDEX_MAX_AGE_DAYS;
    indexCache = { items: fresh ? (data.items || []) : [], updatedAt: ts, ageDays, fresh, total: data ? (data.items || []).length : 0 };
    return indexCache;
  }

  /* 【管理者】区×全カテゴリを検索し、place_id と位置だけを保存（各語 最大3ページ）。
     withWebsites（既定 true）のときは公式サイトURLも受け取り、結果の sites として返す。
     サイトURLは Google のコンテンツなので保存せず、画像抽出ツールへの受け渡しにだけ使う */
  async function collect(opts) {
    opts = opts || {};
    const wards = opts.wards || WARDS, log = opts.onLog || (() => {});
    const withWeb = opts.withWebsites !== false;
    const items = new Map(), sites = new Map(); let calls = 0, stopped = null;
    outer:
    for (const w of wards) {
      for (const [cat, qs] of Object.entries(QUERIES)) {
        for (const q of qs) {
          let token = null, page = 0;
          do {
            let r;
            try { r = await searchText(q + " " + w.name, w, token, true, withWeb); }
            catch (e) { log(`⚠️ ${w.name} / ${q}: ${e.message}`); stopped = "error"; break outer; }
            if (r.blocked) { stopped = r.blocked; log("⛔ 今月の予算上限に達したため中断しました"); break outer; }
            calls++; page++;
            r.places.forEach(p => {
              if (!items.has(p.pid) && p.lat != null)
                items.set(p.pid, { pid: p.pid, lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), cat, ward: w.name });
              if (p.website && !sites.has(p.pid)) sites.set(p.pid, p.website);
            });
            log(`${w.name} / ${q}（${page}ページ目）: ${r.places.length}件`);
            token = r.next;
            await sleep(250);
          } while (token && page < 3);
        }
      }
    }
    const list = [...items.values()];
    if (!opts.dryRun && list.length) {
      const d = await fdb();
      if (d) {
        await d.collection("meta").doc("googlePlaces").set({
          items: list, wards: wards.map(w => w.name), calls,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        localStorage.setItem("wc_gindex", JSON.stringify({ items: list, updatedAt: Date.now() }));
      }
      indexCache = null;
    }
    return { count: list.length, calls, stopped, sites: [...sites].map(([pid, url]) => ({ pid, url })) };
  }

  const mapsLink = (pid, name) =>
    "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(name || "Google Maps") + "&query_place_id=" + encodeURIComponent(pid);

  window.GPlaces = {
    enabled: !!KEY, WARDS, QUERIES, BUDGET,
    wardByName: n => WARDS.find(w => w.name === n) || null,
    searchCategory, details, photoUrl, loadIndex, collect, usage, mapsLink,
  };
})();
