/* ===========================================================
   Wan & Co. — shared client-side logic (demo, local-only)
   Persists to localStorage so everything works offline.
   In production, swap Store.* for Firebase Auth + Firestore/Storage.
   =========================================================== */

const DB = {
  USERS:  "wc_users",
  PLACES: "wc_places",
  SESSION:"wc_session",
  SEEDED: "wc_seeded_v1",
};

/* ---------- tiny helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const read  = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

function timeAgo(ts) {
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
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------- categories ---------- */
const CATEGORIES = [
  { key: "all",   label: "すべて",   icon: "◈" },
  { key: "cafe",  label: "カフェ・飲食", icon: "☕" },
  { key: "hotel", label: "宿泊",     icon: "🛎" },
  { key: "park",  label: "公園",     icon: "🌳" },
  { key: "shop",  label: "ショップ",  icon: "🛍" },
  { key: "other", label: "その他",   icon: "✦" },
];
const catLabel = k => (CATEGORIES.find(c => c.key === k) || {}).label || "その他";

/* ===========================================================
   Auth (demo). Passwords stored locally for the demo only.
   =========================================================== */
const Auth = {
  currentUser() { return read(DB.SESSION, null); },
  requireLogin() {
    if (!this.currentUser()) { location.href = "index.html"; return false; }
    return true;
  },
  signup({ name, email, password }) {
    const users = read(DB.USERS, {});
    if (users[email]) throw new Error("このメールアドレスは既に登録されています。");
    users[email] = { id: uid(), name, email, password, joined: Date.now() };
    write(DB.USERS, users);
    const u = { ...users[email] }; delete u.password;
    write(DB.SESSION, u);
    return u;
  },
  login({ email, password }) {
    const users = read(DB.USERS, {});
    const rec = users[email];
    if (!rec || rec.password !== password) throw new Error("メールアドレスまたはパスワードが正しくありません。");
    const u = { ...rec }; delete u.password;
    write(DB.SESSION, u);
    return u;
  },
  logout() { localStorage.removeItem(DB.SESSION); location.href = "index.html"; },
};

/* ===========================================================
   Places data layer
   =========================================================== */
const Store = {
  all() { return read(DB.PLACES, []); },
  get(id) { return this.all().find(p => p.id === id); },
  save(list) { write(DB.PLACES, list); },

  /* places visible to a given user: public ones + own private ones */
  visible(user) {
    return this.all().filter(p => p.visibility === "public" || (user && p.ownerId === user.id));
  },

  add(place, user) {
    const list = this.all();
    const rec = {
      id: uid(),
      source: "user",                 // "google" (default) | "user"
      ownerId: user ? user.id : null,
      ownerName: user ? user.name : "ゲスト",
      createdAt: Date.now(),
      visibility: place.visibility || "public",
      checkins: [],
      reviews: [],
      photos: [],
      ...place,
    };
    list.unshift(rec);
    this.save(list);
    return rec;
  },

  addReview(id, user, { rating, text }) {
    const list = this.all(); const p = list.find(x => x.id === id);
    if (!p) return;
    p.reviews = p.reviews || [];
    p.reviews.unshift({ id: uid(), userId: user.id, userName: user.name, rating, text, at: Date.now() });
    this.save(list);
    return p;
  },

  checkIn(id, user) {
    const list = this.all(); const p = list.find(x => x.id === id);
    if (!p) return { place: p, added: false };
    p.checkins = p.checkins || [];
    const already = p.checkins.some(c => c.userId === user.id &&
      new Date(c.at).toDateString() === new Date().toDateString());
    if (already) return { place: p, added: false };
    p.checkins.push({ userId: user.id, userName: user.name, at: Date.now() });
    this.save(list);
    return { place: p, added: true };
  },

  avgRating(p) {
    const r = (p.reviews || []).filter(x => x.rating);
    if (!r.length) return null;
    return (r.reduce((a, b) => a + b.rating, 0) / r.length);
  },
};

const stars = n => "★★★★★☆☆☆☆☆".slice(5 - Math.round(n), 10 - Math.round(n));

/* ===========================================================
   Seed data — simulates facilities "already on Google Maps"
   (source: "google"). Users can comment / check-in on these.
   Coordinates around central Tokyo.
   =========================================================== */
function seedIfNeeded() {
  if (read(DB.SEEDED, false)) return;
  const img = id => `https://images.unsplash.com/${id}?q=80&w=900&auto=format&fit=crop`;
  const now = Date.now();
  const seed = [
    {
      id: "g1", source: "google", ownerName: "Google Maps", visibility: "public",
      name: "青山テラス ドッグカフェ", category: "cafe",
      address: "東京都港区南青山5-1-1", lat: 35.6628, lng: 139.7127,
      desc: "テラス席は全席リード可。天然水と手作りおやつのウェルカムサービスあり。",
      photos: [img("photo-1517849845537-4d257902454a")],
      checkins: [], createdAt: now,
      reviews: [{ id: uid(), userName: "Kenji", rating: 5, at: now - 86400000 * 3,
        text: "落ち着いた大人の空間。愛犬用メニューも上質でした。" }],
    },
    {
      id: "g2", source: "google", ownerName: "Google Maps", visibility: "public",
      name: "代々木 セントラルパーク ドッグラン", category: "park",
      address: "東京都渋谷区代々木神園町2-1", lat: 35.6720, lng: 139.6940,
      desc: "大型犬・小型犬エリア分け。芝生が美しく朝夕は涼しい。",
      photos: [img("photo-1552053831-71594a27632d")],
      checkins: [{ userName: "Aya", at: now - 3600000 }], createdAt: now,
      reviews: [],
    },
    {
      id: "g3", source: "google", ownerName: "Google Maps", visibility: "public",
      name: "ホテル・ル・シアン 白金", category: "hotel",
      address: "東京都港区白金台4-6-2", lat: 35.6370, lng: 139.7280,
      desc: "愛犬同伴スイート完備。専用アメニティとドッグシッター手配可。",
      photos: [img("photo-1566073771259-6a8506099945")],
      checkins: [], createdAt: now,
      reviews: [{ id: uid(), userName: "Miho", rating: 5, at: now - 86400000 * 10,
        text: "非日常の滞在。スタッフの対応も一流でした。" }],
    },
    {
      id: "g4", source: "google", ownerName: "Google Maps", visibility: "public",
      name: "丸の内 テラスダイニング", category: "cafe",
      address: "東京都千代田区丸の内2-4-1", lat: 35.6812, lng: 139.7660,
      desc: "夜景の見えるテラスで愛犬とディナー。ソムリエ在籍。",
      photos: [img("photo-1414235077428-338989a2e8c0")],
      checkins: [], createdAt: now, reviews: [],
    },
  ];
  Store.save(seed.concat(Store.all()));
  write(DB.SEEDED, true);
}
seedIfNeeded();

/* ===========================================================
   File -> dataURL (photo upload for demo; use Firebase Storage in prod)
   =========================================================== */
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/* shared bottom nav renderer */
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
