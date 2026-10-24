/* ===========================================================
   Wan & Co. — unified data layer (async)
   -----------------------------------------------------------
   ひとつの API で「Firebase(共有)」と「localStorage(端末内)」を
   切り替えます。config.js の firebase.apiKey があれば Firebase を、
   なければ localStorage を自動選択します。

   公開 API（すべて Promise を返します）:
     Data.ready()                       -> Promise<user|null>  初期化＋認証状態
     Data.onAuth(fn)                    認証状態の変化を購読
     Data.mode                          "firebase" | "local"

     Auth.currentUser()                 -> user|null （同期・キャッシュ）
     Auth.signup({name,email,password}) -> Promise<user>
     Auth.login({email,password})       -> Promise<user>
     Auth.logout()                      -> Promise

     Store.visible()                    -> Promise<place[]>   閲覧可能な全スポット
     Store.mine()                       -> Promise<place[]>   自分の登録スポット
     Store.get(id)                      -> Promise<place|null>（カード用の要約）
     Store.detail(id)                   -> Promise<{place,reviews,photos,checkedInToday}>
     Store.add(fields, files)           -> Promise<id>
     Store.addReview(id,{rating,text})  -> Promise
     Store.checkIn(id)                  -> Promise<{added,count}>
     Store.setVisibility(id,vis)        -> Promise
     Store.remove(id)                   -> Promise
     Store.myStats()                    -> Promise<{places,checkins,reviews}>

   place（要約）: {id,name,category,address,desc,lat,lng,visibility,
                   source,ownerId,ownerName,cover,checkinCount,reviewCount,avg}
   =========================================================== */
(function () {
  const cfg = (window.WC_CONFIG || {});
  const fb = cfg.firebase || {};
  const useFirebase = !!(fb.apiKey && fb.projectId);

  const Data = { mode: useFirebase ? "firebase" : "local", ready: null, onAuth: null };
  window.Data = Data;

  /* ---------- shared helpers ---------- */
  const uid = () => Math.random().toString(36).slice(2, 10);
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const today = () => new Date().toISOString().slice(0, 10);

  /* 画像を縮小して dataURL 化（Storage不要で Firestore に収める） */
  window.compressImage = function (file, maxSide, quality) {
    maxSide = maxSide || 1200; quality = quality || 0.7;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        if (Math.max(w, h) > maxSide) { const r = maxSide / Math.max(w, h); w = Math.round(w * r); h = Math.round(h * r); }
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      const fr = new FileReader(); fr.onload = () => (img.src = fr.result); fr.onerror = reject; fr.readAsDataURL(file);
    });
  };

  const SEED = seedData();
  const avgOf = p => (p.reviewCount ? (p.ratingSum || 0) / p.reviewCount : null);

  /* 店内同伴可否の実効値。ユーザー報告（多数決）を優先し、無ければ元データ(OSM等)を使う */
  function effIndoor(d) {
    const y = d.indoorYes || 0, n = d.indoorNo || 0;
    if (y || n) return y > n ? true : (n > y ? false : null);
    return d.indoorOk ?? null;
  }

  /* Google Places の types（＋施設名）→ アプリのカテゴリー */
  function catFromTypes(types, primary, name) {
    const t = (primary ? [primary] : []).concat(types || []).map(x => String(x).toLowerCase());
    const has = k => t.some(x => x.includes(k));
    const nm = String(name || "");
    // 施設名のキーワードで細分類（Google types に無い区分を補う）
    if (/トレーニング|しつけ|スクール|訓練|幼稚園|保育園|ドッグラン以外.*教室|dog ?training|obedience/i.test(nm)) return "school";
    if (/トリミング|サロン|グルーミング|美容|trimming|grooming/i.test(nm)) return "salon";
    if (/動物病院|獣医|クリニック|ペットクリニック|veterinary|animal ?hospital/i.test(nm) || has("veterinary")) return "clinic";
    if (has("lodging") || has("hotel")) return "hotel";
    if (has("dog_park") || has("park")) return "park";
    if (has("pet_store") || has("store") || has("shop")) return "shop";
    if (has("restaurant") || has("cafe") || has("coffee") || has("food") || has("bar") || has("bakery")) return "cafe";
    return "other";
  }
  const placeDocId = pid => "gp_" + String(pid).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  window.catFromGoogleTypes = catFromTypes; // 検索結果のカテゴリー判定に利用

  /* =======================================================================
     静的スポットデータ（OSM）
     GitHub Pages から配信される assets/osm-data.json を読み込む。
     Firestore の読み取り枠を消費しない「ベースの施設一覧」。
     ユーザーが口コミ・チェックインした施設だけ Firestore に昇格される。
     ======================================================================= */
  const OSM_DATA_URL = "assets/osm-data.json?v=20260706b";
  // false のとき OSM 由来のスポット（静的データ・Firestore昇格済みとも）を画面に出さない。データ自体は保持
  const SHOW_OSM = !!(window.WC_CONFIG && WC_CONFIG.SHOW_OSM_DATA);
  const showable = p => SHOW_OSM || (p && p.source !== "osm");
  let staticCache = null;
  async function loadStaticPlaces() {
    if (staticCache) return staticCache;
    const map = new Map();
    if (!SHOW_OSM) return (staticCache = map);
    try {
      const r = await fetch(OSM_DATA_URL);
      (await r.json()).forEach(p => map.set(p.id, {
        id: p.id, source: "osm", name: p.name, category: p.category || "other",
        address: p.address || "", desc: "", lat: p.lat ?? null, lng: p.lng ?? null,
        tel: p.tel || "", website: p.website || "", indoorOk: p.indoorOk ?? null, area: p.area || "",
        visibility: "public", ownerId: null, ownerName: "OpenStreetMap", cover: "", placeId: "",
        checkinCount: 0, reviewCount: 0, avg: null,
      }));
    } catch (e) { /* 読み込み失敗時は静的データなしで続行 */ }
    staticCache = map;
    return map;
  }

  /* =======================================================================
     Google 施設（id = "gp_<place_id>"）
     規約上、保存してよいのは place_id のみ。店名・住所などは保存せず、
     表示時に gplaces.js が Google から取得する。ここでは「中身の無い器」を扱う。
     ======================================================================= */
  const isGp = id => typeof id === "string" && id.startsWith("gp_");
  const hints = new Map(); // id -> { category } 画面側が分かっている分類（自社の分類なので保存可）
  Data.hintPlace = (id, meta) => { hints.set(id, Object.assign({}, hints.get(id), meta)); };
  function gpStub(id) {
    const h = hints.get(id) || {};
    return {
      id, source: "gplace", placeId: id.slice(3), name: "", address: "", desc: "",
      category: h.category || "other", lat: null, lng: null, visibility: "public",
      ownerId: null, ownerName: "Google", cover: "", tel: "", website: "", area: "",
      indoorOk: null, indoorYes: 0, indoorNo: 0, checkinCount: 0, reviewCount: 0, avg: null,
    };
  }

  /* =======================================================================
     LOCAL BACKEND (localStorage) — 端末内。データ共有なし。
     ======================================================================= */
  function localBackend() {
    const K = { USERS: "wc_users", SESSION: "wc_session", PLACES: "wc_places", SEEDED: "wc_seeded_v2", SAVES: "wc_saves" };
    if (!read(K.SEEDED, false)) { write(K.PLACES, SEED.concat(read(K.PLACES, []))); write(K.SEEDED, true); }

    let cur = read(K.SESSION, null);
    const authSubs = [];
    const emit = () => authSubs.forEach(fn => fn(cur));

    const Auth = {
      currentUser: () => cur,
      async signup({ name, email, password }) {
        const users = read(K.USERS, {});
        if (users[email]) throw new Error("このメールアドレスは既に登録されています。");
        const u = { id: uid(), name, email, password, joined: Date.now() };
        users[email] = u; write(K.USERS, users);
        cur = { id: u.id, name, email }; write(K.SESSION, cur); emit(); return cur;
      },
      async login({ email, password }) {
        const rec = read(K.USERS, {})[email];
        if (!rec || rec.password !== password) throw new Error("メールアドレスまたはパスワードが正しくありません。");
        cur = { id: rec.id, name: rec.name, email }; write(K.SESSION, cur); emit(); return cur;
      },
      async logout() { cur = null; localStorage.removeItem(K.SESSION); emit(); },
    };

    const all = () => read(K.PLACES, []);
    const saveAll = list => write(K.PLACES, list);
    const summary = p => ({
      id: p.id, name: p.name, category: p.category, address: p.address, desc: p.desc,
      lat: p.lat, lng: p.lng, visibility: p.visibility, source: p.source,
      ownerId: p.ownerId, ownerName: p.ownerName, cover: (p.photos && p.photos[0]) || "", placeId: p.placeId || "",
      tel: p.tel || "", website: p.website || "", area: p.area || "",
      indoorOk: effIndoor({ indoorOk: p.indoorOk, indoorYes: (p.dogReports || []).filter(r => r.ok).length, indoorNo: (p.dogReports || []).filter(r => !r.ok).length }),
      indoorYes: (p.dogReports || []).filter(r => r.ok).length,
      indoorNo: (p.dogReports || []).filter(r => !r.ok).length,
      checkinCount: (p.checkins || []).length, reviewCount: (p.reviews || []).length, avg: avgLocal(p),
    });
    const avgLocal = p => { const r = (p.reviews || []).filter(x => x.rating); return r.length ? r.reduce((a, b) => a + b.rating, 0) / r.length : null; };

    /* 静的(OSM)スポットを、口コミ/チェックイン時にローカルDBへ取り込む */
    async function ensureLocal(id) {
      const list = all();
      if (list.some(p => p.id === id)) return;
      if (isGp(id)) { // Google 施設：place_id と自社分類のみ保存
        const s = gpStub(id);
        list.unshift({ id, source: "gplace", placeId: s.placeId, ownerId: cur ? cur.id : null, ownerName: "Google",
          name: "", category: s.category, address: "", visibility: "public", photos: [], checkins: [], reviews: [], createdAt: Date.now() });
        saveAll(list); return;
      }
      const stat = (await loadStaticPlaces()).get(id);
      if (!stat) return;
      list.unshift({ id, source: "osm", ownerId: cur ? cur.id : null, ownerName: "OpenStreetMap",
        name: stat.name, category: stat.category, address: stat.address, desc: "",
        tel: stat.tel, website: stat.website, indoorOk: stat.indoorOk, area: stat.area,
        lat: stat.lat, lng: stat.lng, visibility: "public", photos: [], checkins: [], reviews: [], createdAt: Date.now() });
      saveAll(list);
    }

    const Store = {
      async visible() {
        const stat = await loadStaticPlaces();
        const out = new Map(stat);
        all().filter(p => p.visibility === "public" || (cur && p.ownerId === cur.id))
          .forEach(p => out.set(p.id, summary(p)));
        return [...out.values()].filter(showable);
      },
      async mine() { return all().filter(p => cur && p.ownerId === cur.id && p.source === "user").map(summary); },
      async get(id) {
        const p = all().find(x => x.id === id);
        if (p) return summary(p);
        return (await loadStaticPlaces()).get(id) || null;
      },
      async detail(id) {
        const p = all().find(x => x.id === id);
        if (!p) {
          const stat = (await loadStaticPlaces()).get(id) || (isGp(id) ? gpStub(id) : null);
          return stat ? { place: stat, reviews: [], photos: [], checkedInToday: false, myIndoorReport: null } : null;
        }
        const checkedInToday = (p.checkins || []).some(c => cur && c.userId === cur.id && new Date(c.at).toISOString().slice(0, 10) === today());
        const mine = (p.dogReports || []).find(r => cur && r.userId === cur.id);
        return { place: summary(p), reviews: (p.reviews || []).slice(), photos: (p.photos || []).slice(),
          checkedInToday, myIndoorReport: mine ? mine.ok : null };
      },

      /* 店内同伴の報告（1人1票・変更可） */
      async reportIndoor(id, ok) {
        if (!cur) return;
        await ensureLocal(id);
        const list = all(); const p = list.find(x => x.id === id); if (!p) return;
        p.dogReports = (p.dogReports || []).filter(r => r.userId !== cur.id);
        p.dogReports.push({ userId: cur.id, ok, at: Date.now() });
        saveAll(list);
      },
      async add(f, files) {
        const photos = [];
        for (const file of (files || [])) photos.push(await window.compressImage(file));
        const list = all();
        const rec = { id: uid(), source: "user", ownerId: cur.id, ownerName: cur.name, createdAt: Date.now(),
          visibility: f.visibility || "public", name: f.name, category: f.category, address: f.address,
          tel: f.tel || "", indoorOk: f.indoorOk ?? null,
          desc: f.desc, lat: f.lat, lng: f.lng, photos, checkins: [], reviews: [] };
        list.unshift(rec); saveAll(list); return rec.id;
      },
      async importPlace(g) {
        const id = placeDocId(g.placeId); const list = all();
        if (list.some(p => p.id === id)) return id;
        list.unshift({ id, source: "places", ownerId: cur ? cur.id : null, ownerName: "Google Places", placeId: g.placeId || "",
          name: g.name, category: catFromTypes(g.types, g.primaryType, g.name), address: g.address || "", desc: "",
          lat: g.lat, lng: g.lng, visibility: "public", photos: g.photoUrl ? [g.photoUrl] : [], checkins: [], reviews: [], createdAt: Date.now() });
        saveAll(list); return id;
      },
      async addReview(id, { rating, text }) {
        await ensureLocal(id);
        const list = all(); const p = list.find(x => x.id === id); if (!p) return;
        (p.reviews = p.reviews || []).unshift({ id: uid(), userId: cur.id, userName: cur.name, rating, text, at: Date.now() });
        saveAll(list);
      },
      async checkIn(id) {
        await ensureLocal(id);
        const list = all(); const p = list.find(x => x.id === id); if (!p) return { added: false, count: 0 };
        p.checkins = p.checkins || [];
        if (p.checkins.some(c => c.userId === cur.id && new Date(c.at).toISOString().slice(0, 10) === today()))
          return { added: false, count: p.checkins.length };
        p.checkins.push({ userId: cur.id, userName: cur.name, at: Date.now() }); saveAll(list);
        return { added: true, count: p.checkins.length };
      },
      async setVisibility(id, vis) { const list = all(); const p = list.find(x => x.id === id); if (p) { p.visibility = vis; saveAll(list); } },
      async remove(id) { saveAll(all().filter(x => x.id !== id)); },

      /* お気に入り（保存） */
      async savedIds() { return read(K.SAVES, {})[cur ? cur.id : "_"] || []; },
      async saveFavorite(id) { const m = read(K.SAVES, {}); const k = cur ? cur.id : "_"; const a = m[k] || []; if (a.indexOf(id) === -1) a.push(id); m[k] = a; write(K.SAVES, m); },
      async unsaveFavorite(id) { const m = read(K.SAVES, {}); const k = cur ? cur.id : "_"; m[k] = (m[k] || []).filter(x => x !== id); write(K.SAVES, m); },
      async saved() {
        const [ids, stat] = [await this.savedIds(), await loadStaticPlaces()];
        return ids.map(id => { const p = all().find(x => x.id === id); return p ? summary(p) : (stat.get(id) || (isGp(id) ? gpStub(id) : null)); }).filter(p => p && showable(p));
      },

      async myStats() {
        const list = all();
        return {
          places: list.filter(p => p.ownerId === cur.id).length,
          checkins: list.reduce((n, p) => n + (p.checkins || []).filter(c => c.userId === cur.id).length, 0),
          reviews: list.reduce((n, p) => n + (p.reviews || []).filter(r => r.userId === cur.id).length, 0),
        };
      },
    };

    Data.onAuth = fn => { authSubs.push(fn); fn(cur); };
    Data.ready = () => Promise.resolve(cur);
    window.Auth = Auth; window.Store = Store;
  }

  /* =======================================================================
     FIREBASE BACKEND (Auth + Firestore) — みんなで共有。
     ======================================================================= */
  function firebaseBackend() {
    const V = "10.12.2";
    const scripts = [
      `https://www.gstatic.com/firebasejs/${V}/firebase-app-compat.js`,
      `https://www.gstatic.com/firebasejs/${V}/firebase-auth-compat.js`,
      `https://www.gstatic.com/firebasejs/${V}/firebase-firestore-compat.js`,
    ];
    // 並列にダウンロードし、実行順は async=false で保証する
    const loadSeq = arr => Promise.all(arr.map(src => new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.async = false;
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    })));

    let cur = null, resolveReady;
    const readyP = new Promise(r => (resolveReady = r));
    // index.html が認証SDKの読み込みを待たずにマップへ進むための目印（認証の本確認は各ページで行う）
    const setAuthHint = on => { try { on ? localStorage.setItem("wc_auth_hint", "1") : localStorage.removeItem("wc_auth_hint"); } catch (e) {} };
    const authSubs = [];
    let db, auth, FS;

    const bootstrap = loadSeq(scripts).then(() => {
      firebase.initializeApp(fb);
      auth = firebase.auth(); db = firebase.firestore(); FS = firebase.firestore;
      auth.onAuthStateChanged(u => {
        cur = u ? { id: u.uid, name: u.displayName || (u.email || "").split("@")[0], email: u.email } : null;
        setAuthHint(!!cur);
        authSubs.forEach(fn => fn(cur));
        resolveReady(cur);
        if (cur) seedIfNeeded().catch(() => {});
      });
    });

    const Auth = {
      currentUser: () => cur,
      async signup({ name, email, password }) {
        await bootstrap;
        const { user } = await auth.createUserWithEmailAndPassword(email, password);
        await user.updateProfile({ displayName: name });
        await db.collection("users").doc(user.uid).set(
          { name, email, placeCount: 0, checkinCount: 0, reviewCount: 0, joined: FS.FieldValue.serverTimestamp() }, { merge: true });
        cur = { id: user.uid, name, email };
        return cur;
      },
      async login({ email, password }) {
        await bootstrap;
        try { await auth.signInWithEmailAndPassword(email, password); }
        catch (e) { throw new Error(mapAuthError(e)); }
        return cur;
      },
      async logout() { setAuthHint(false); await bootstrap; await auth.signOut(); },
    };

    const summary = (id, d) => ({
      id, name: d.name || "", category: d.category, address: d.address || "", desc: d.desc,
      lat: d.lat ?? null, lng: d.lng ?? null, visibility: d.visibility, source: d.source,
      ownerId: d.ownerId, ownerName: d.ownerName, cover: d.cover || "", placeId: d.placeId || "",
      tel: d.tel || "", website: d.website || "", indoorOk: effIndoor(d), area: d.area || "",
      indoorYes: d.indoorYes || 0, indoorNo: d.indoorNo || 0,
      checkinCount: d.checkinCount || 0, reviewCount: d.reviewCount || 0,
      avg: d.reviewCount ? (d.ratingSum || 0) / d.reviewCount : null,
    });

    /* 静的(OSM)スポットを、初回の口コミ/チェックイン時に Firestore へ「昇格」させる */
    async function ensurePlaceDoc(id) {
      if (isGp(id)) { // Google 施設：place_id と自社分類だけの器を作る（店名・住所等は保存しない）
        try { const d = await db.collection("places").doc(id).get(); if (d.exists) return; } catch (e) { /* 未作成 */ }
        const s = gpStub(id);
        await db.collection("places").doc(id).set({
          source: "gplace", placeId: s.placeId, ownerId: cur.id, ownerName: "Google",
          category: s.category, visibility: "public",
          checkinCount: 0, reviewCount: 0, ratingSum: 0,
          createdAt: FS.FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
      }
      const stat = (await loadStaticPlaces()).get(id);
      if (!stat) return; // 静的データ由来でなければ既存doc前提
      try { await db.collection("places").doc(id).get(); return; } // 取得できれば作成済み
      catch (e) { /* 未作成（permission-denied）→ 作成へ */ }
      await db.collection("places").doc(id).set({
        source: "osm", ownerId: cur.id, ownerName: "OpenStreetMap",
        name: stat.name, category: stat.category, address: stat.address, desc: "",
        tel: stat.tel, website: stat.website, indoorOk: stat.indoorOk, area: stat.area,
        lat: stat.lat, lng: stat.lng, visibility: "public", cover: "",
        checkinCount: 0, reviewCount: 0, ratingSum: 0,
        attribution: "© OpenStreetMap contributors",
        createdAt: FS.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    let savedIdsP = null;
    const Store = {
      async visible() {
        await bootstrap;
        // 静的(OSM)データが土台。Firestore側（ユーザー登録・昇格済み・Google取込）が同IDを上書き。
        const [stat, pub, own] = await Promise.all([
          loadStaticPlaces(),
          db.collection("places").where("visibility", "==", "public").get(),
          cur ? db.collection("places").where("ownerId", "==", cur.id).get() : null,
        ]);
        const out = new Map(stat);
        pub.forEach(doc => out.set(doc.id, summary(doc.id, doc.data())));
        if (own) own.forEach(doc => out.set(doc.id, summary(doc.id, doc.data())));
        return [...out.values()].filter(showable).sort((a, b) => (b.source === "user") - (a.source === "user"));
      },
      async mine() {
        await bootstrap; if (!cur) return [];
        const snap = await db.collection("places").where("ownerId", "==", cur.id).get();
        // 自分で登録したスポットのみ（初回シードの「Google Map掲載」施設は除外）
        return snap.docs.filter(d => d.data().source === "user").map(d => summary(d.id, d.data()));
      },
      async get(id) {
        await bootstrap;
        try { const doc = await db.collection("places").doc(id).get(); if (doc.exists) return summary(doc.id, doc.data()); }
        catch (e) { /* 未作成の静的スポット */ }
        return (await loadStaticPlaces()).get(id) || null;
      },
      async detail(id) {
        await bootstrap;
        const ref = db.collection("places").doc(id);
        let doc = null;
        try { doc = await ref.get(); } catch (e) { doc = null; }
        if (!doc || !doc.exists) {
          // Firestore 未昇格の静的(OSM)スポット／Google 施設 → 読み取り消費ゼロで表示
          const stat = (await loadStaticPlaces()).get(id) || (isGp(id) ? gpStub(id) : null);
          return stat ? { place: stat, reviews: [], photos: [], checkedInToday: false, myIndoorReport: null } : null;
        }
        const [rev, pho, chk, rep] = await Promise.all([
          ref.collection("reviews").orderBy("at", "desc").get(),
          ref.collection("photos").orderBy("at", "asc").get(),
          cur ? ref.collection("checkins").doc(`${cur.id}_${today()}`).get() : Promise.resolve({ exists: false }),
          cur ? ref.collection("dogReports").doc(cur.id).get().catch(() => ({ exists: false })) : Promise.resolve({ exists: false }),
        ]);
        return {
          place: summary(doc.id, doc.data()),
          reviews: rev.docs.map(d => ({ id: d.id, ...d.data(), at: tsToMs(d.data().at) })),
          photos: pho.docs.map(d => d.data().url),
          checkedInToday: chk.exists,
          myIndoorReport: rep.exists ? rep.data().ok : null,
        };
      },

      /* 店内同伴の報告（1人1票・変更可） */
      async reportIndoor(id, ok) {
        await bootstrap; if (!cur) return;
        await ensurePlaceDoc(id); // 静的スポットなら Firestore へ昇格
        const ref = db.collection("places").doc(id);
        const rep = ref.collection("dogReports").doc(cur.id);
        await db.runTransaction(async tx => {
          const prev = await tx.get(rep);
          const prevOk = prev.exists ? prev.data().ok : null;
          if (prevOk === ok) return; // 変更なし
          let dy = 0, dn = 0;
          if (prevOk === true) dy--; else if (prevOk === false) dn--;
          if (ok === true) dy++; else dn++;
          tx.set(rep, { userId: cur.id, ok, at: FS.FieldValue.serverTimestamp() });
          const upd = {};
          if (dy) upd.indoorYes = FS.FieldValue.increment(dy);
          if (dn) upd.indoorNo = FS.FieldValue.increment(dn);
          if (Object.keys(upd).length) tx.update(ref, upd);
        });
      },
      async add(f, files) {
        await bootstrap;
        const covers = [];
        for (const file of (files || [])) covers.push(await window.compressImage(file));
        const ref = await db.collection("places").add({
          source: "user", ownerId: cur.id, ownerName: cur.name, name: f.name, category: f.category,
          address: f.address || "", desc: f.desc || "", lat: f.lat ?? null, lng: f.lng ?? null,
          tel: f.tel || "", indoorOk: f.indoorOk ?? null,
          visibility: f.visibility || "public", cover: covers[0] || "",
          checkinCount: 0, reviewCount: 0, ratingSum: 0, createdAt: FS.FieldValue.serverTimestamp(),
        });
        for (const url of covers) await ref.collection("photos").add({ url, at: FS.FieldValue.serverTimestamp() });
        if (cur) db.collection("users").doc(cur.id).set({ placeCount: FS.FieldValue.increment(1) }, { merge: true }).catch(() => {});
        return ref.id;
      },
      /* Places API の検索結果を DB に取り込む（place_id で重複排除） */
      async importPlace(g) {
        await bootstrap;
        const id = placeDocId(g.placeId);
        const ref = db.collection("places").doc(id);
        // 既存確認。未登録docは読取ルール上 permission-denied になるため、その場合は新規として扱う。
        let exists = false;
        try { exists = (await ref.get()).exists; } catch (e) { exists = false; }
        if (exists) return id;
        await ref.set({
          source: "places", ownerId: cur.id, ownerName: "Google Places", placeId: g.placeId,
          name: g.name, category: catFromTypes(g.types, g.primaryType, g.name), address: g.address || "",
          desc: "", lat: g.lat, lng: g.lng, visibility: "public", cover: g.photoUrl || "",
          checkinCount: 0, reviewCount: 0, ratingSum: 0, createdAt: FS.FieldValue.serverTimestamp(),
        });
        if (g.photoUrl) await ref.collection("photos").add({ url: g.photoUrl, at: FS.FieldValue.serverTimestamp() });
        return id;
      },
      async addReview(id, { rating, text }) {
        await bootstrap;
        await ensurePlaceDoc(id); // 静的スポットなら Firestore へ昇格
        const ref = db.collection("places").doc(id);
        await ref.collection("reviews").add({ userId: cur.id, userName: cur.name, rating, text, at: FS.FieldValue.serverTimestamp() });
        await ref.update({ reviewCount: FS.FieldValue.increment(1), ratingSum: FS.FieldValue.increment(rating) });
        db.collection("users").doc(cur.id).set({ reviewCount: FS.FieldValue.increment(1) }, { merge: true }).catch(() => {});
      },
      async checkIn(id) {
        await bootstrap;
        await ensurePlaceDoc(id); // 静的スポットなら Firestore へ昇格
        const ref = db.collection("places").doc(id);
        const ck = ref.collection("checkins").doc(`${cur.id}_${today()}`);
        const res = await db.runTransaction(async tx => {
          const snap = await tx.get(ck);
          const cnt = (await tx.get(ref)).data().checkinCount || 0;
          if (snap.exists) return { added: false, count: cnt };
          tx.set(ck, { userId: cur.id, userName: cur.name, at: FS.FieldValue.serverTimestamp() });
          tx.update(ref, { checkinCount: FS.FieldValue.increment(1) });
          return { added: true, count: cnt + 1 };
        });
        if (res.added) db.collection("users").doc(cur.id).set({ checkinCount: FS.FieldValue.increment(1) }, { merge: true }).catch(() => {});
        return res;
      },
      async setVisibility(id, vis) { await bootstrap; await db.collection("places").doc(id).update({ visibility: vis }); },
      async remove(id) { await bootstrap; await db.collection("places").doc(id).delete(); },

      /* お気に入り（保存）: users/{uid}.savedIds に配列で保持。ページ内ではメモリに保持して再読込を省く */
      async savedIds() {
        await bootstrap; if (!cur) return [];
        if (!savedIdsP) savedIdsP = db.collection("users").doc(cur.id).get()
          .then(u => (u.exists && u.data().savedIds) ? u.data().savedIds.slice() : [])
          .catch(e => { savedIdsP = null; throw e; });
        return (await savedIdsP).slice();
      },
      async saveFavorite(id) {
        await bootstrap; if (!cur) return;
        await db.collection("users").doc(cur.id).set({ savedIds: FS.FieldValue.arrayUnion(id) }, { merge: true });
        if (savedIdsP) savedIdsP = savedIdsP.then(a => a.includes(id) ? a : a.concat(id));
      },
      async unsaveFavorite(id) {
        await bootstrap; if (!cur) return;
        await db.collection("users").doc(cur.id).set({ savedIds: FS.FieldValue.arrayRemove(id) }, { merge: true });
        if (savedIdsP) savedIdsP = savedIdsP.then(a => a.filter(x => x !== id));
      },
      async saved() {
        await bootstrap; if (!cur) return [];
        const [ids, stat] = await Promise.all([this.savedIds(), loadStaticPlaces()]);
        const docs = await Promise.all(ids.map(id =>
          db.collection("places").doc(id).get().catch(() => null))); // 未作成のdocは permission-denied
        return ids.map((id, i) => {
          const doc = docs[i];
          if (doc && doc.exists) return summary(doc.id, doc.data());
          return stat.get(id) || (isGp(id) ? gpStub(id) : null);
        }).filter(p => p && showable(p));
      },

      async myStats() {
        await bootstrap; if (!cur) return { places: 0, checkins: 0, reviews: 0 };
        const u = await db.collection("users").doc(cur.id).get();
        const d = u.exists ? u.data() : {};
        return { places: d.placeCount || 0, checkins: d.checkinCount || 0, reviews: d.reviewCount || 0 };
      },
    };

    /* 「Google Maps掲載」施設を一度だけ投入（固定ID・存在すればスキップ） */
    async function seedIfNeeded() {
      try { if (localStorage.getItem("wc_seeded_v1")) return; } catch (e) {}
      const marker = db.collection("meta").doc("seeded_v1");
      const m = await marker.get();
      if (m.exists) { try { localStorage.setItem("wc_seeded_v1", "1"); } catch (e) {} return; }
      const batch = db.batch();
      // ownerId / userId は最初にログインしたユーザーに紐付ける（セキュリティルールを満たすため）。
      // ただし source:"google" として扱い、本人の「マイページ」には表示しない（mine() で除外）。
      SEED.forEach(s => {
        const ref = db.collection("places").doc(s.id);
        batch.set(ref, {
          source: "google", ownerId: cur.id, ownerName: "Google Maps", name: s.name, category: s.category,
          address: s.address, desc: s.desc, lat: s.lat, lng: s.lng, visibility: "public",
          cover: (s.photos && s.photos[0]) || "", checkinCount: (s.checkins || []).length,
          reviewCount: (s.reviews || []).length, ratingSum: (s.reviews || []).reduce((a, b) => a + (b.rating || 0), 0),
          createdAt: FS.FieldValue.serverTimestamp(),
        }, { merge: true });
        (s.photos || []).forEach((url) => batch.set(ref.collection("photos").doc(), { url, at: FS.FieldValue.serverTimestamp() }));
        (s.reviews || []).forEach((r) => batch.set(ref.collection("reviews").doc(),
          { userId: cur.id, userName: r.userName, rating: r.rating, text: r.text, at: FS.FieldValue.serverTimestamp() }));
      });
      batch.set(marker, { at: FS.FieldValue.serverTimestamp() });
      await batch.commit();
    }

    const tsToMs = t => (t && t.toMillis ? t.toMillis() : (typeof t === "number" ? t : Date.now()));
    const mapAuthError = e => ({
      "auth/invalid-credential": "メールアドレスまたはパスワードが正しくありません。",
      "auth/wrong-password": "メールアドレスまたはパスワードが正しくありません。",
      "auth/user-not-found": "このメールアドレスは登録されていません。",
      "auth/invalid-email": "メールアドレスの形式が正しくありません。",
    }[e.code] || (e.message || "ログインに失敗しました。"));

    Data.onAuth = fn => { authSubs.push(fn); bootstrap.then(() => fn(cur)); };
    Data.ready = () => bootstrap.then(() => readyP);
    window.Auth = Auth; window.Store = Store;
  }

  if (useFirebase) firebaseBackend(); else localBackend();

  /* =======================================================================
     seed content（両バックエンド共通）
     ======================================================================= */
  function seedData() {
    const img = id => `https://images.unsplash.com/${id}?q=80&w=900&auto=format&fit=crop`;
    const now = Date.now();
    return [
      { id: "g1", source: "google", ownerName: "Google Maps", visibility: "public", name: "青山テラス ドッグカフェ",
        category: "cafe", address: "東京都港区南青山5-1-1", lat: 35.6628, lng: 139.7127,
        desc: "テラス席は全席リード可。天然水と手作りおやつのウェルカムサービスあり。", photos: [img("photo-1517849845537-4d257902454a")],
        checkins: [], reviews: [{ userName: "Kenji", rating: 5, text: "落ち着いた大人の空間。愛犬用メニューも上質でした。" }] },
      { id: "g2", source: "google", ownerName: "Google Maps", visibility: "public", name: "代々木 セントラルパーク ドッグラン",
        category: "park", address: "東京都渋谷区代々木神園町2-1", lat: 35.6720, lng: 139.6940,
        desc: "大型犬・小型犬エリア分け。芝生が美しく朝夕は涼しい。", photos: [img("photo-1552053831-71594a27632d")],
        checkins: [{ userName: "Aya", at: now }], reviews: [] },
      { id: "g3", source: "google", ownerName: "Google Maps", visibility: "public", name: "ホテル・ル・シアン 白金",
        category: "hotel", address: "東京都港区白金台4-6-2", lat: 35.6370, lng: 139.7280,
        desc: "愛犬同伴スイート完備。専用アメニティとドッグシッター手配可。", photos: [img("photo-1566073771259-6a8506099945")],
        checkins: [], reviews: [{ userName: "Miho", rating: 5, text: "非日常の滞在。スタッフの対応も一流でした。" }] },
      { id: "g4", source: "google", ownerName: "Google Maps", visibility: "public", name: "丸の内 テラスダイニング",
        category: "cafe", address: "東京都千代田区丸の内2-4-1", lat: 35.6812, lng: 139.7660,
        desc: "夜景の見えるテラスで愛犬とディナー。ソムリエ在籍。", photos: [img("photo-1414235077428-338989a2e8c0")],
        checkins: [], reviews: [] },
    ];
  }
})();
