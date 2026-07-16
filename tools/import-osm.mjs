#!/usr/bin/env node
/* ===========================================================
   Wan & Co. — OSM(OpenStreetMap) インポータ
   -----------------------------------------------------------
   首都圏の「犬と行けるスポット」を Overpass API から取得し、
   アプリの places スキーマに正規化した JSON を生成、
   そのまま Firestore に一括投入できます。Google API 不使用・無料。

   使い方:
     1) データ取得（依存パッケージ不要 / Node 18+）
        node tools/import-osm.mjs fetch
        → tools/osm-places.json が生成される

     2) Firestore へ投入（要: npm i firebase-admin と サービスアカウント鍵）
        node tools/import-osm.mjs import --key /path/to/serviceAccountKey.json

   データ出典: © OpenStreetMap contributors (ODbL)
   住所の逆ジオコーディング: 国土地理院 (GSI) API
   =========================================================== */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, "osm-places.json");
const UA = "WanAndCo-Importer/1.0 (dog-friendly app; contact: tomi119000@gmail.com)";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/* HTTP は curl 経由（Node の fetch が使えない環境でも動くように） */
function httpGet(url, timeoutSec = 30) {
  try {
    return execFileSync("curl", ["-s", "--max-time", String(timeoutSec), "-A", UA, url],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) { return ""; }
}
function httpPostForm(url, dataValue, timeoutSec = 240) {
  try {
    return execFileSync("curl",
      ["-s", "--max-time", String(timeoutSec), "-A", UA, "--data-urlencode", "data@-", url],
      { input: dataValue, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) { return ""; }
}

/* ---------- 対象範囲（首都圏）: 4分割して負荷を分散 ---------- */
const BBOXES = [
  [35.45, 139.25, 35.70, 139.65], // 南西（川崎・横浜北部・多摩南）
  [35.45, 139.65, 35.70, 140.00], // 南東（都心南・湾岸・千葉西）
  [35.70, 139.25, 35.95, 139.65], // 北西（多摩北・埼玉南西）
  [35.70, 139.65, 35.95, 140.00], // 北東（都心北・埼玉南東・千葉北西）
];

const queryFor = ([s, w, n, e]) => `
[out:json][timeout:180];
(
  nwr["dog"~"yes|leashed"](${s},${w},${n},${e});
  nwr["leisure"="dog_park"](${s},${w},${n},${e});
  nwr["amenity"="veterinary"](${s},${w},${n},${e});
  nwr["shop"~"^pet$|^pet_grooming$"](${s},${w},${n},${e});
  nwr["amenity"="animal_boarding"](${s},${w},${n},${e});
);
out center;`;

/* ---------- カテゴリ判定（アプリの CATEGORIES と対応） ---------- */
function categorize(tags) {
  const name = tags.name || "";
  // 施設名キーワード（OSMタグに無い区分を補完）
  if (/トレーニング|しつけ|訓練|幼稚園|保育園|dog ?training|obedience/i.test(name)) return "school";
  if (/トリミング|グルーミング|trimming|grooming/i.test(name)) return "salon";
  if (/一時預かり|ペットホテル(?!.*宿)|boarding/i.test(name)) return "daycare";
  if (/シッター|sitter/i.test(name)) return "sitter";
  if (/介護|老犬|シニア犬/i.test(name)) return "care";
  if (/霊園|供養|メモリアル|火葬|memorial/i.test(name)) return "memorial";
  // OSM タグ
  if (tags.amenity === "veterinary") return "clinic";
  if (tags.amenity === "animal_boarding") return "daycare";
  if (tags.shop === "pet_grooming") return "salon";
  if (tags.shop === "pet") return "shop";
  if (tags.leisure === "dog_park") return "park";
  if (tags.leisure === "park" || tags.leisure === "garden") return "park";
  if (tags.tourism === "hotel" || tags.tourism === "guest_house") return "hotel";
  if (["cafe", "restaurant", "bar", "pub", "fast_food", "ice_cream"].includes(tags.amenity)) return "cafe";
  return "other";
}

/* dog タグ → 店内同伴可否 */
function indoorOkFrom(tags) {
  const d = (tags.dog || "").toLowerCase();
  if (d === "yes" || d === "leashed") return true;
  if (d === "no") return false;
  if (d === "outside" || d === "terrace") return false; // テラスのみ
  return null; // 不明
}

const phoneOf = t => t.phone || t["contact:phone"] || "";
const webOf = t => t.website || t["contact:website"] || "";

/* addr:* タグから住所文字列（あれば） */
function addrFromTags(t) {
  if (t["addr:full"]) return t["addr:full"];
  const parts = [t["addr:province"], t["addr:city"], t["addr:quarter"], t["addr:neighbourhood"],
    t["addr:block_number"] ? t["addr:block_number"] + "-" + (t["addr:housenumber"] || "") : t["addr:housenumber"]];
  const s = parts.filter(Boolean).join("");
  return s || "";
}

/* ---------- GSI 逆ジオコーダ（緯度経度 → 市区町村＋町名） ---------- */
const MUNI = {
  // 東京23区
  "13101":"東京都千代田区","13102":"東京都中央区","13103":"東京都港区","13104":"東京都新宿区","13105":"東京都文京区",
  "13106":"東京都台東区","13107":"東京都墨田区","13108":"東京都江東区","13109":"東京都品川区","13110":"東京都目黒区",
  "13111":"東京都大田区","13112":"東京都世田谷区","13113":"東京都渋谷区","13114":"東京都中野区","13115":"東京都杉並区",
  "13116":"東京都豊島区","13117":"東京都北区","13118":"東京都荒川区","13119":"東京都板橋区","13120":"東京都練馬区",
  "13121":"東京都足立区","13122":"東京都葛飾区","13123":"東京都江戸川区",
  // 東京・市部（主要）
  "13201":"東京都八王子市","13202":"東京都立川市","13203":"東京都武蔵野市","13204":"東京都三鷹市","13205":"東京都青梅市",
  "13206":"東京都府中市","13207":"東京都昭島市","13208":"東京都調布市","13209":"東京都町田市","13210":"東京都小金井市",
  "13211":"東京都小平市","13212":"東京都日野市","13213":"東京都東村山市","13214":"東京都国分寺市","13215":"東京都国立市",
  "13218":"東京都福生市","13219":"東京都狛江市","13220":"東京都東大和市","13221":"東京都清瀬市","13222":"東京都東久留米市",
  "13223":"東京都武蔵村山市","13224":"東京都多摩市","13225":"東京都稲城市","13227":"東京都羽村市","13228":"東京都あきる野市","13229":"東京都西東京市",
  // 横浜市
  "14101":"横浜市鶴見区","14102":"横浜市神奈川区","14103":"横浜市西区","14104":"横浜市中区","14105":"横浜市南区",
  "14106":"横浜市保土ケ谷区","14107":"横浜市磯子区","14108":"横浜市金沢区","14109":"横浜市港北区","14110":"横浜市戸塚区",
  "14111":"横浜市港南区","14112":"横浜市旭区","14113":"横浜市緑区","14114":"横浜市瀬谷区","14115":"横浜市栄区",
  "14116":"横浜市泉区","14117":"横浜市青葉区","14118":"横浜市都筑区",
  // 川崎市
  "14131":"川崎市川崎区","14132":"川崎市幸区","14133":"川崎市中原区","14134":"川崎市高津区","14135":"川崎市多摩区",
  "14136":"川崎市宮前区","14137":"川崎市麻生区",
  // 相模原市・神奈川主要
  "14151":"相模原市緑区","14152":"相模原市中央区","14153":"相模原市南区",
  "14201":"神奈川県横須賀市","14203":"神奈川県平塚市","14204":"神奈川県鎌倉市","14205":"神奈川県藤沢市",
  "14206":"神奈川県小田原市","14207":"神奈川県茅ヶ崎市","14208":"神奈川県逗子市","14210":"神奈川県三浦市",
  "14211":"神奈川県秦野市","14212":"神奈川県厚木市","14213":"神奈川県大和市","14214":"神奈川県伊勢原市",
  "14215":"神奈川県海老名市","14216":"神奈川県座間市","14218":"神奈川県綾瀬市",
  // さいたま市
  "11101":"さいたま市西区","11102":"さいたま市北区","11103":"さいたま市大宮区","11104":"さいたま市見沼区","11105":"さいたま市中央区",
  "11106":"さいたま市桜区","11107":"さいたま市浦和区","11108":"さいたま市南区","11109":"さいたま市緑区","11110":"さいたま市岩槻区",
  // 埼玉主要
  "11201":"埼玉県川越市","11202":"埼玉県熊谷市","11203":"埼玉県川口市","11206":"埼玉県行田市","11208":"埼玉県所沢市",
  "11209":"埼玉県飯能市","11212":"埼玉県東松山市","11214":"埼玉県春日部市","11215":"埼玉県狭山市","11217":"埼玉県鴻巣市",
  "11218":"埼玉県深谷市","11219":"埼玉県上尾市","11221":"埼玉県草加市","11222":"埼玉県越谷市","11223":"埼玉県蕨市",
  "11224":"埼玉県戸田市","11225":"埼玉県入間市","11227":"埼玉県朝霞市","11228":"埼玉県志木市","11229":"埼玉県和光市",
  "11230":"埼玉県新座市","11231":"埼玉県桶川市","11232":"埼玉県久喜市","11233":"埼玉県北本市","11234":"埼玉県八潮市",
  "11235":"埼玉県富士見市","11237":"埼玉県三郷市","11238":"埼玉県蓮田市","11239":"埼玉県坂戸市","11240":"埼玉県幸手市",
  "11241":"埼玉県鶴ヶ島市","11242":"埼玉県日高市","11243":"埼玉県吉川市","11245":"埼玉県ふじみ野市","11246":"埼玉県白岡市",
  // 千葉市・千葉主要
  "12101":"千葉市中央区","12102":"千葉市花見川区","12103":"千葉市稲毛区","12104":"千葉市若葉区","12105":"千葉市緑区","12106":"千葉市美浜区",
  "12203":"千葉県市川市","12204":"千葉県船橋市","12206":"千葉県木更津市","12207":"千葉県松戸市","12208":"千葉県野田市",
  "12210":"千葉県茂原市","12211":"千葉県成田市","12212":"千葉県佐倉市","12216":"千葉県習志野市","12217":"千葉県柏市",
  "12219":"千葉県市原市","12220":"千葉県流山市","12221":"千葉県八千代市","12222":"千葉県我孫子市","12224":"千葉県鎌ケ谷市",
  "12227":"千葉県浦安市","12228":"千葉県四街道市","12232":"千葉県白井市","12233":"千葉県富里市","12236":"千葉県印西市",
};

const geoCache = new Map();
async function reverseGeocode(lat, lng) {
  const key = lat.toFixed(4) + "," + lng.toFixed(4);
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const text = httpGet(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`, 15);
    const j = JSON.parse(text || "{}");
    const res = j && j.results;
    const muni = res && MUNI[res.muniCd];
    const addr = muni ? muni + (res.lv01Nm && res.lv01Nm !== "－" ? res.lv01Nm : "") : "";
    geoCache.set(key, addr);
    return addr;
  } catch (e) { geoCache.set(key, ""); return ""; }
}

/* ---------- エリアキー（アプリの AREAS と同じ定義） ---------- */
const AREAS = [
  { key: "minato",     lat: 35.658, lng: 139.732, r: 2.6 },
  { key: "shibuya",    lat: 35.661, lng: 139.703, r: 2.2 },
  { key: "ebisu",      lat: 35.646, lng: 139.708, r: 2.0 },
  { key: "futako",     lat: 35.611, lng: 139.626, r: 2.2 },
  { key: "jiyugaoka",  lat: 35.607, lng: 139.668, r: 1.8 },
  { key: "shinjuku",   lat: 35.686, lng: 139.702, r: 2.4 },
  { key: "marunouchi", lat: 35.681, lng: 139.767, r: 2.0 },
  { key: "kichijoji",  lat: 35.703, lng: 139.580, r: 2.0 },
];
function distKm(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const areaOf = (lat, lng) => (AREAS.find(a => distKm(a.lat, a.lng, lat, lng) <= a.r) || {}).key || "";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===================== fetch ===================== */
async function runFetch() {
  const all = new Map();
  for (const [i, bbox] of BBOXES.entries()) {
    process.stdout.write(`[${i + 1}/${BBOXES.length}] Overpass 取得中 bbox=${bbox.join(",")} ... `);
    let json = null;
    for (const ep of OVERPASS_ENDPOINTS) {
      const text = httpPostForm(ep, queryFor(bbox));
      if (text.trim().startsWith("{")) {
        try { json = JSON.parse(text); break; } catch (e) {}
      }
      console.log(`\n  (${ep} 失敗、次のミラーを試行)`);
    }
    if (!json) { console.log("スキップ（全エンドポイント失敗）"); continue; }
    const els = json.elements || [];
    console.log(`${els.length}件`);
    for (const el of els) {
      const t = el.tags || {};
      if (!t.name) continue; // 名前の無いPOIは除外
      const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const id = `osm_${el.type}${el.id}`;
      all.set(id, {
        id, source: "osm", sourceId: `${el.type}/${el.id}`,
        name: t.name,
        category: categorize(t),
        address: addrFromTags(t),
        tel: phoneOf(t),
        website: webOf(t),
        indoorOk: indoorOkFrom(t),
        lat: +lat.toFixed(6), lng: +lng.toFixed(6),
        area: areaOf(lat, lng),
        visibility: "public",
        attribution: "© OpenStreetMap contributors",
      });
    }
    await sleep(2000); // サーバーに配慮
  }

  // 住所の無いものを GSI で逆ジオコーディング（丁寧に 5req/s）
  const list = [...all.values()];
  const need = list.filter(p => !p.address);
  console.log(`\n住所補完（国土地理院）: ${need.length}/${list.length} 件`);
  let done = 0;
  for (const p of need) {
    p.address = await reverseGeocode(p.lat, p.lng);
    if (++done % 50 === 0) console.log(`  ...${done}/${need.length}`);
    await sleep(200);
  }

  writeFileSync(OUT_FILE, JSON.stringify(list, null, 1));
  const byCat = {};
  list.forEach(p => byCat[p.category] = (byCat[p.category] || 0) + 1);
  console.log(`\n✅ 保存: ${OUT_FILE}`);
  console.log(`   合計 ${list.length} 件 / カテゴリ内訳:`, byCat);
  console.log(`   住所あり: ${list.filter(p => p.address).length} 件`);
}

/* ===================== import ===================== */
async function runImport(keyPath) {
  if (!existsSync(OUT_FILE)) { console.error("先に fetch を実行してください: node tools/import-osm.mjs fetch"); process.exit(1); }
  if (!keyPath || !existsSync(keyPath)) {
    console.error("サービスアカウント鍵を指定してください: --key /path/to/serviceAccountKey.json");
    console.error("(Firebase コンソール → プロジェクトの設定 → サービスアカウント → 新しい秘密鍵の生成)");
    process.exit(1);
  }
  let admin;
  try { admin = (await import("firebase-admin")).default; }
  catch { console.error("firebase-admin が必要です: cd tools && npm i firebase-admin"); process.exit(1); }

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(keyPath, "utf8"))) });
  const db = admin.firestore();
  const list = JSON.parse(readFileSync(OUT_FILE, "utf8"));
  console.log(`Firestore へ投入: ${list.length} 件（既存IDは上書き更新・重複しません）`);

  let batch = db.batch(), n = 0, committed = 0;
  for (const p of list) {
    const ref = db.collection("places").doc(p.id);
    batch.set(ref, {
      source: "osm", sourceId: p.sourceId, ownerId: null, ownerName: "OpenStreetMap",
      name: p.name, category: p.category, address: p.address || "", desc: "",
      tel: p.tel || "", website: p.website || "", indoorOk: p.indoorOk,
      lat: p.lat, lng: p.lng, area: p.area || "", visibility: "public", cover: "",
      checkinCount: 0, reviewCount: 0, ratingSum: 0,
      attribution: p.attribution,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (++n % 400 === 0) { await batch.commit(); committed += 400; console.log(`  ...${committed}件`); batch = db.batch(); }
  }
  await batch.commit();
  console.log(`✅ 完了: ${list.length} 件を places コレクションに投入しました`);
}

/* ===================== main ===================== */
const cmd = process.argv[2];
const keyIdx = process.argv.indexOf("--key");
const keyPath = keyIdx > -1 ? process.argv[keyIdx + 1] : "";
if (cmd === "fetch") runFetch();
else if (cmd === "import") runImport(keyPath);
else console.log("使い方:\n  node tools/import-osm.mjs fetch\n  node tools/import-osm.mjs import --key serviceAccountKey.json");
