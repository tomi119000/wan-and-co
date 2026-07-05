/* ===========================================================
   Wan & Co. — UI helpers（データ層は data.js を参照）
   =========================================================== */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "たった今";
  const m = Math.floor(s / 60); if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}日前`;
  return new Date(ts).toLocaleDateString("ja-JP");
}

function toast(msg) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2400);
}

const CATEGORIES = [
  { key: "all",    label: "すべて",     icon: "◈" },
  { key: "cafe",   label: "カフェ・飲食", icon: "☕" },
  { key: "hotel",  label: "宿泊",       icon: "🛎" },
  { key: "park",   label: "公園",       icon: "🌳" },
  { key: "shop",   label: "ショップ",    icon: "🛍" },
  { key: "school", label: "スクール",    icon: "🎓" },  // ドッグトレーニング・しつけ
  { key: "salon",  label: "サロン",     icon: "✂️" },  // トリミング
  { key: "clinic", label: "動物病院",   icon: "🏥" },
  { key: "other",  label: "その他",     icon: "✦" },
];
const catLabel = k => (CATEGORIES.find(c => c.key === k) || {}).label || "その他";

/* 住所から所在地概要を抽出（例: "〒150-0001 東京都渋谷区神宮前３丁目…" → "東京都渋谷区神宮前３丁目"） */
function areaSummary(addr) {
  if (!addr) return "";
  let s = String(addr).replace(/〒?\s*\d{3}-?\d{4}\s*/, "").trim(); // 郵便番号を除去
  s = s.replace(/^日本[、,]?\s*/, "");                              // 先頭の「日本」を除去
  const m = s.match(/^(.*?[0-9０-９一二三四五六七八九十]+丁目)/);      // 丁目まで
  if (m) return m[1];
  return s.replace(/[0-9０-９].*$/, "").trim();                     // 番地以降を除去
}

/* 主要エリア（スポット画面のエリア絞り込み用・中心座標＋半径km） */
const AREAS = [
  { key: "all",        label: "すべてのエリア" },
  { key: "minato",     label: "港区（南青山・白金・六本木）", lat: 35.658, lng: 139.732, r: 2.6 },
  { key: "shibuya",    label: "渋谷・原宿・代官山",         lat: 35.661, lng: 139.703, r: 2.2 },
  { key: "ebisu",      label: "恵比寿・中目黒",            lat: 35.646, lng: 139.708, r: 2.0 },
  { key: "futako",     label: "二子玉川",                lat: 35.611, lng: 139.626, r: 2.2 },
  { key: "jiyugaoka",  label: "自由が丘",                lat: 35.607, lng: 139.668, r: 1.8 },
  { key: "shinjuku",   label: "新宿・代々木",             lat: 35.686, lng: 139.702, r: 2.4 },
  { key: "marunouchi", label: "丸の内・東京",             lat: 35.681, lng: 139.767, r: 2.0 },
  { key: "kichijoji",  label: "吉祥寺",                  lat: 35.703, lng: 139.580, r: 2.0 },
];
/* 2点間の距離(km)・簡易 */
function distKm(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function inArea(p, areaKey) {
  const a = AREAS.find(x => x.key === areaKey);
  if (!a || a.key === "all") return true;
  if (p.lat == null) return false;
  return distKm(a.lat, a.lng, p.lat, p.lng) <= a.r;
}
const stars = n => "★★★★★☆☆☆☆☆".slice(5 - Math.round(n), 10 - Math.round(n));

/* Google Maps/Places が有効か（config のキー有無）。無効時は課金を発生させない。 */
const GOOGLE_ON = !!((((window.WC_CONFIG || {}).GOOGLE_MAPS_API_KEY) || "").trim());
/* Google 写真URLは Place Photo として課金対象。Google無効時は読み込まない。 */
function safeCover(cover) {
  if (!cover) return "";
  if (!GOOGLE_ON && /googleapis\.com|googleusercontent\.com/.test(cover)) return "";
  return cover;
}

/* card markup shared by map / list / mypage */
function placeCardHTML(p, opts) {
  opts = opts || {};
  const showSave = opts.showSave !== false; // 既定で「保存」ボタンを表示
  const cover = safeCover(p.cover);
  // 写真が無く placeId がある施設は、あとで Places API から写真を後埋めする（Google有効時のみ）
  const needFetch = !cover && p.placeId && GOOGLE_ON;
  const thumbStyle = cover ? `background-image:url('${cover}')` : "background-color:#ded9cf";
  const fetchAttr = needFetch ? ` data-photo="${escapeHtml(p.placeId)}"` : "";
  const saveBtn = showSave
    ? `<button class="save-btn" data-id="${escapeHtml(p.id || "")}" data-pid="${escapeHtml(p.placeId || "")}" aria-label="保存">♡</button>`
    : "";
  return `
    <div class="thumb"${fetchAttr} style="${thumbStyle}">
      <span class="badge">${catLabel(p.category)}</span>
      ${p.visibility === "private" ? `<span class="lock">🔒 非公開</span>` : ""}
      ${saveBtn}
    </div>
    <div class="body">
      <h3>${escapeHtml(p.name)}</h3>
      ${p.address ? `<div class="card-loc">📍 ${escapeHtml(areaSummary(p.address))}</div>` : ""}
      ${p.desc ? `<p class="card-desc">${escapeHtml(p.desc)}</p>` : ""}
      <div class="meta">
        ${p.avg ? `<span class="stars">${stars(p.avg)}</span> <span>${p.avg.toFixed(1)}</span>` : `<span>口コミなし</span>`}
        <span>📍 ${p.checkinCount || 0} チェックイン</span>
        <span>${p.source === "user" ? "ユーザー登録" : "Google Map掲載"}</span>
      </div>
    </div>`;
}

/* 写真が無いカードに、Places API から取得した写真を後から差し込む */
function hydrateCardPhotos(root) {
  if (!(window.WCMap && WCMap.ready)) return;
  WCMap.ready().then(() => {
    if (!(WCMap.canSearch && WCMap.fetchPhoto)) return; // Google Maps モードのみ
    $$('.thumb[data-photo]', root || document).forEach(el => {
      const pid = el.getAttribute("data-photo");
      el.removeAttribute("data-photo"); // 二重取得を防ぐ
      WCMap.fetchPhoto(pid).then(url => { if (url) el.style.backgroundImage = `url('${url}')`; }).catch(() => {});
    });
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function mountNav(active) {
  const nav = document.createElement("nav");
  nav.className = "bottomnav";
  nav.innerHTML = `
    <a href="map.html" data-k="map"><span class="ic">🗺</span>マップ</a>
    <a href="list.html" data-k="list"><span class="ic">≡</span>スポット</a>
    <a href="add.html" class="add" data-k="add"><span class="ic">＋</span>登録</a>
    <a href="saved.html" data-k="saved"><span class="ic">♥</span>保存</a>
    <a href="mypage.html" data-k="my"><span class="ic">◔</span>マイページ</a>`;
  const a = nav.querySelector(`[data-k="${active}"]`);
  if (a) a.classList.add("active");
  document.body.appendChild(nav);
}

/* ---- 保存（お気に入り）ボタンの配線・トグル ---- */
async function wireSaveButtons(root) {
  if (!(window.Store && Store.savedIds)) return;
  let savedSet = [];
  try { savedSet = await Store.savedIds(); } catch (e) {}
  $$(".save-btn", root || document).forEach(btn => {
    const id = btn.dataset.id;
    if (id && savedSet.indexOf(id) !== -1) { btn.classList.add("saved"); btn.textContent = "♥"; }
    btn.onclick = e => { e.preventDefault(); e.stopPropagation(); toggleSave(btn); };
  });
}

async function toggleSave(btn) {
  if (btn._busy) return; btn._busy = true;
  try {
    let id = btn.dataset.id;
    if (!id) { // 検索結果（未登録）はまず取り込んでから保存
      const g = (window.__saveResolve && btn.dataset.pid) ? window.__saveResolve(btn.dataset.pid) : null;
      if (!g) { toast("保存できませんでした。"); btn._busy = false; return; }
      id = await Store.importPlace(g); btn.dataset.id = id;
    }
    if (btn.classList.contains("saved")) {
      await Store.unsaveFavorite(id);
      btn.classList.remove("saved"); btn.textContent = "♡"; toast("保存を解除しました。");
    } else {
      await Store.saveFavorite(id);
      btn.classList.add("saved"); btn.textContent = "♥"; toast("保存しました ♥");
    }
  } catch (e) { toast("保存に失敗しました。"); }
  btn._busy = false;
}
