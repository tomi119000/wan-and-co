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

  /* =======================================================================
     LOCAL BACKEND (localStorage) — 端末内。データ共有なし。
     ======================================================================= */
  function localBackend() {
    const K = { USERS: "wc_users", SESSION: "wc_session", PLACES: "wc_places", SEEDED: "wc_seeded_v2" };
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
      ownerId: p.ownerId, ownerName: p.ownerName, cover: (p.photos && p.photos[0]) || "",
      checkinCount: (p.checkins || []).length, reviewCount: (p.reviews || []).length, avg: avgLocal(p),
    });
    const avgLocal = p => { const r = (p.reviews || []).filter(x => x.rating); return r.length ? r.reduce((a, b) => a + b.rating, 0) / r.length : null; };

    const Store = {
      async visible() { return all().filter(p => p.visibility === "public" || (cur && p.ownerId === cur.id)).map(summary); },
      async mine() { return all().filter(p => cur && p.ownerId === cur.id).map(summary); },
      async get(id) { const p = all().find(x => x.id === id); return p ? summary(p) : null; },
      async detail(id) {
        const p = all().find(x => x.id === id); if (!p) return null;
        const checkedInToday = (p.checkins || []).some(c => cur && c.userId === cur.id && new Date(c.at).toISOString().slice(0, 10) === today());
        return { place: summary(p), reviews: (p.reviews || []).slice(), photos: (p.photos || []).slice(), checkedInToday };
      },
      async add(f, files) {
        const photos = [];
        for (const file of (files || [])) photos.push(await window.compressImage(file));
        const list = all();
        const rec = { id: uid(), source: "user", ownerId: cur.id, ownerName: cur.name, createdAt: Date.now(),
          visibility: f.visibility || "public", name: f.name, category: f.category, address: f.address,
          desc: f.desc, lat: f.lat, lng: f.lng, photos, checkins: [], reviews: [] };
        list.unshift(rec); saveAll(list); return rec.id;
      },
      async addReview(id, { rating, text }) {
        const list = all(); const p = list.find(x => x.id === id); if (!p) return;
        (p.reviews = p.reviews || []).unshift({ id: uid(), userId: cur.id, userName: cur.name, rating, text, at: Date.now() });
        saveAll(list);
      },
      async checkIn(id) {
        const list = all(); const p = list.find(x => x.id === id); if (!p) return { added: false, count: 0 };
        p.checkins = p.checkins || [];
        if (p.checkins.some(c => c.userId === cur.id && new Date(c.at).toISOString().slice(0, 10) === today()))
          return { added: false, count: p.checkins.length };
        p.checkins.push({ userId: cur.id, userName: cur.name, at: Date.now() }); saveAll(list);
        return { added: true, count: p.checkins.length };
      },
      async setVisibility(id, vis) { const list = all(); const p = list.find(x => x.id === id); if (p) { p.visibility = vis; saveAll(list); } },
      async remove(id) { saveAll(all().filter(x => x.id !== id)); },
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
    const loadSeq = arr => arr.reduce((pr, src) => pr.then(() => new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    })), Promise.resolve());

    let cur = null, resolveReady;
    const readyP = new Promise(r => (resolveReady = r));
    const authSubs = [];
    let db, auth, FS;

    const bootstrap = loadSeq(scripts).then(() => {
      firebase.initializeApp(fb);
      auth = firebase.auth(); db = firebase.firestore(); FS = firebase.firestore;
      auth.onAuthStateChanged(u => {
        cur = u ? { id: u.uid, name: u.displayName || (u.email || "").split("@")[0], email: u.email } : null;
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
      async logout() { await bootstrap; await auth.signOut(); },
    };

    const summary = (id, d) => ({
      id, name: d.name, category: d.category, address: d.address, desc: d.desc,
      lat: d.lat ?? null, lng: d.lng ?? null, visibility: d.visibility, source: d.source,
      ownerId: d.ownerId, ownerName: d.ownerName, cover: d.cover || "",
      checkinCount: d.checkinCount || 0, reviewCount: d.reviewCount || 0,
      avg: d.reviewCount ? (d.ratingSum || 0) / d.reviewCount : null,
    });

    const Store = {
      async visible() {
        await bootstrap;
        const out = new Map();
        const pub = await db.collection("places").where("visibility", "==", "public").get();
        pub.forEach(doc => out.set(doc.id, summary(doc.id, doc.data())));
        if (cur) {
          const own = await db.collection("places").where("ownerId", "==", cur.id).get();
          own.forEach(doc => out.set(doc.id, summary(doc.id, doc.data())));
        }
        return [...out.values()].sort((a, b) => (b.source === "user") - (a.source === "user"));
      },
      async mine() {
        await bootstrap; if (!cur) return [];
        const snap = await db.collection("places").where("ownerId", "==", cur.id).get();
        return snap.docs.map(d => summary(d.id, d.data()));
      },
      async get(id) { await bootstrap; const doc = await db.collection("places").doc(id).get(); return doc.exists ? summary(doc.id, doc.data()) : null; },
      async detail(id) {
        await bootstrap;
        const ref = db.collection("places").doc(id);
        const doc = await ref.get(); if (!doc.exists) return null;
        const [rev, pho, chk] = await Promise.all([
          ref.collection("reviews").orderBy("at", "desc").get(),
          ref.collection("photos").orderBy("at", "asc").get(),
          cur ? ref.collection("checkins").doc(`${cur.id}_${today()}`).get() : Promise.resolve({ exists: false }),
        ]);
        return {
          place: summary(doc.id, doc.data()),
          reviews: rev.docs.map(d => ({ id: d.id, ...d.data(), at: tsToMs(d.data().at) })),
          photos: pho.docs.map(d => d.data().url),
          checkedInToday: chk.exists,
        };
      },
      async add(f, files) {
        await bootstrap;
        const covers = [];
        for (const file of (files || [])) covers.push(await window.compressImage(file));
        const ref = await db.collection("places").add({
          source: "user", ownerId: cur.id, ownerName: cur.name, name: f.name, category: f.category,
          address: f.address || "", desc: f.desc || "", lat: f.lat ?? null, lng: f.lng ?? null,
          visibility: f.visibility || "public", cover: covers[0] || "",
          checkinCount: 0, reviewCount: 0, ratingSum: 0, createdAt: FS.FieldValue.serverTimestamp(),
        });
        for (const url of covers) await ref.collection("photos").add({ url, at: FS.FieldValue.serverTimestamp() });
        if (cur) db.collection("users").doc(cur.id).set({ placeCount: FS.FieldValue.increment(1) }, { merge: true }).catch(() => {});
        return ref.id;
      },
      async addReview(id, { rating, text }) {
        await bootstrap;
        const ref = db.collection("places").doc(id);
        await ref.collection("reviews").add({ userId: cur.id, userName: cur.name, rating, text, at: FS.FieldValue.serverTimestamp() });
        await ref.update({ reviewCount: FS.FieldValue.increment(1), ratingSum: FS.FieldValue.increment(rating) });
        db.collection("users").doc(cur.id).set({ reviewCount: FS.FieldValue.increment(1) }, { merge: true }).catch(() => {});
      },
      async checkIn(id) {
        await bootstrap;
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
      async myStats() {
        await bootstrap; if (!cur) return { places: 0, checkins: 0, reviews: 0 };
        const u = await db.collection("users").doc(cur.id).get();
        const d = u.exists ? u.data() : {};
        return { places: d.placeCount || 0, checkins: d.checkinCount || 0, reviews: d.reviewCount || 0 };
      },
    };

    /* 「Google Maps掲載」施設を一度だけ投入（固定ID・存在すればスキップ） */
    async function seedIfNeeded() {
      const marker = db.collection("meta").doc("seeded_v1");
      const m = await marker.get(); if (m.exists) return;
      const batch = db.batch();
      SEED.forEach(s => {
        const ref = db.collection("places").doc(s.id);
        batch.set(ref, {
          source: "google", ownerId: null, ownerName: "Google Maps", name: s.name, category: s.category,
          address: s.address, desc: s.desc, lat: s.lat, lng: s.lng, visibility: "public",
          cover: (s.photos && s.photos[0]) || "", checkinCount: (s.checkins || []).length,
          reviewCount: (s.reviews || []).length, ratingSum: (s.reviews || []).reduce((a, b) => a + (b.rating || 0), 0),
          createdAt: FS.FieldValue.serverTimestamp(),
        }, { merge: true });
        (s.photos || []).forEach((url, i) => batch.set(ref.collection("photos").doc("seed" + i), { url, at: FS.FieldValue.serverTimestamp() }));
        (s.reviews || []).forEach((r, i) => batch.set(ref.collection("reviews").doc("seed" + i),
          { userName: r.userName, rating: r.rating, text: r.text, at: FS.FieldValue.serverTimestamp() }));
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
