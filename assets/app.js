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
  { key: "all",   label: "すべて",     icon: "◈" },
  { key: "cafe",  label: "カフェ・飲食", icon: "☕" },
  { key: "hotel", label: "宿泊",       icon: "🛎" },
  { key: "park",  label: "公園",       icon: "🌳" },
  { key: "shop",  label: "ショップ",    icon: "🛍" },
  { key: "other", label: "その他",     icon: "✦" },
];
const catLabel = k => (CATEGORIES.find(c => c.key === k) || {}).label || "その他";
const stars = n => "★★★★★☆☆☆☆☆".slice(5 - Math.round(n), 10 - Math.round(n));

/* card markup shared by map / list / mypage */
function placeCardHTML(p) {
  // 写真が無く placeId がある施設は、あとで Places API から写真を後埋めする
  const needFetch = !p.cover && p.placeId;
  const thumbStyle = p.cover ? `background-image:url('${p.cover}')` : "background-color:#ded9cf";
  const fetchAttr = needFetch ? ` data-photo="${escapeHtml(p.placeId)}"` : "";
  return `
    <div class="thumb"${fetchAttr} style="${thumbStyle}">
      <span class="badge">${catLabel(p.category)}</span>
      ${p.visibility === "private" ? `<span class="lock">🔒 非公開</span>` : ""}
    </div>
    <div class="body">
      <h3>${escapeHtml(p.name)}</h3>
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
    <a href="mypage.html" data-k="my"><span class="ic">◔</span>マイページ</a>`;
  const a = nav.querySelector(`[data-k="${active}"]`);
  if (a) a.classList.add("active");
  document.body.appendChild(nav);
}
