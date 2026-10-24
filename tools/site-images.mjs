#!/usr/bin/env node
/* ===========================================================
   施設の公式サイトから「共有用画像（og:image 等）」のURLを集め、
   assets/site-images.json（place_id → 画像URL）を更新する。

   使い方（管理画面の月次更新でダウンロードされた一覧ファイルを使う）:
     node tools/site-images.mjs                 # ~/Downloads の最新 wanco-websites-*.json を処理
     node tools/site-images.mjs <一覧.json>      # ファイルを指定
     オプション:
       --publish   処理後に assets/site-images.json をコミットして GitHub Pages へ公開
       --keep      一覧ファイルを削除しない（既定では処理後に削除）
       --limit N   先頭N件だけ処理（動作確認用）

   方針:
   ・画像そのものは保存・複製しない（URLのみ。表示は施設サイトから直接）
   ・Instagram / Facebook 等のSNSは対象外（自動取得は各社の規約で禁止）
   ・robots.txt で全体が拒否されているサイトは取得しない
   ・掲載停止の依頼があったサイトは tools/site-images-exclude.txt にドメインか place_id を1行ずつ書く
   ・一覧ファイルの公式サイトURLは Google のデータなので、処理後に削除し、どこにも保存しない
   =========================================================== */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "site-images.json");
const EXCLUDE = path.join(ROOT, "tools", "site-images-exclude.txt");
const UA = "Mozilla/5.0 (compatible; WanAndCoPreview/1.0; +https://tomi119000.github.io/wan-and-co/)";
const REFERER = "https://tomi119000.github.io/";
const CONCURRENCY = 6;
const SOCIAL = /(^|\.)(instagram\.com|facebook\.com|fb\.com|twitter\.com|x\.com|tiktok\.com|line\.me|youtube\.com|ameblo\.jp|linktr\.ee|lit\.link|google\.com|goo\.gl)$/i;
// グルメ・予約・口コミサイト（施設の公式サイトではなく、画像の権利も各サイトや投稿者にあるため対象外）
const PORTAL = /(^|\.)(tabelog\.com|gnavi\.co\.jp|hotpepper\.jp|retty\.me|getyourguide\.[a-z.]+|tripadvisor\.[a-z.]+|jalan\.net|travel\.rakuten\.co\.jp|ikyu\.com|booking\.com|expedia\.[a-z.]+|hotels\.com|agoda\.com|epark\.jp|beauty\.hotpepper\.jp|minkou\.jp|petlife\.asia|caloo\.jp)$/i;

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
let input = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");

if (!input) {
  const dl = path.join(os.homedir(), "Downloads");
  const files = fs.existsSync(dl) ? fs.readdirSync(dl).filter(f => /^wanco-websites-.*\.json$/.test(f)) : [];
  files.sort((a, b) => fs.statSync(path.join(dl, b)).mtimeMs - fs.statSync(path.join(dl, a)).mtimeMs);
  if (!files.length) {
    console.error("一覧ファイル（wanco-websites-*.json）がダウンロードフォルダに見つかりません。\n管理画面で「インデックスを更新する」を実行してから、もう一度お試しください。");
    process.exit(1);
  }
  input = path.join(dl, files[0]);
}

const list = JSON.parse(fs.readFileSync(input, "utf8"));
let sites = (list.sites || []).filter(s => s && s.pid && s.url);
if (LIMIT) sites = sites.slice(0, LIMIT);
const excluded = new Set(fs.existsSync(EXCLUDE)
  ? fs.readFileSync(EXCLUDE, "utf8").split("\n").map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith("#")) : []);
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { images: {} };

console.log(`📄 ${path.basename(input)}：公式サイト ${sites.length}件を処理します`);

/* ---------- HTTP ---------- */
async function get(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 12000);
  try {
    return await fetch(url, { redirect: "follow", signal: ctl.signal,
      headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8", ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}
async function readText(res, maxBytes) {
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  while (n < maxBytes) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
  try { reader.cancel(); } catch (e) {}
  return Buffer.concat(chunks).toString("utf8");
}

const robotsCache = new Map();
async function robotsAllowsRoot(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let ok = true;
  try {
    const r = await get(origin + "/robots.txt", { timeout: 6000 });
    if (r.ok) {
      const txt = await readText(r, 200000);
      let applies = false;
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
        const [k, ...rest] = line.split(":"); const v = rest.join(":").trim();
        if (/^user-agent$/i.test(k)) applies = v === "*" || /wanandco/i.test(v);
        else if (applies && /^disallow$/i.test(k) && v === "/") { ok = false; break; }
      }
    }
  } catch (e) { /* robots.txt が取れなければ通常どおり */ }
  robotsCache.set(origin, ok);
  return ok;
}

const decode = s => s.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/g, '"').trim();
function findImage(html) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  const pick = names => {
    for (const m of metas) {
      const key = (m.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const val = (m.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (key && val && names.includes(key.toLowerCase())) return decode(val);
    }
    return "";
  };
  return pick(["og:image:secure_url", "og:image", "og:image:url"]) || pick(["twitter:image", "twitter:image:src"])
    || decode((html.match(/<link\b[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i) || [])[1] || "");
}

async function imageOk(url) {
  try {
    const r = await get(url, { timeout: 10000, headers: { Referer: REFERER } });
    const type = r.headers.get("content-type") || "", len = +(r.headers.get("content-length") || 0);
    try { r.body && r.body.cancel(); } catch (e) {}
    return r.ok && /^image\//i.test(type) && !/svg|icon/i.test(type) && (len === 0 || len > 4000);
  } catch (e) { return false; }
}

async function processSite({ pid, url }) {
  let u;
  try { u = new URL(url); } catch (e) { return { pid, skip: "URL不正" }; }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (excluded.has(host) || excluded.has(pid.toLowerCase())) return { pid, skip: "掲載停止リスト" };
  if (SOCIAL.test(u.hostname)) return { pid, skip: "SNS（対象外）" };
  if (PORTAL.test(u.hostname)) return { pid, skip: "グルメ・予約サイト（公式サイトではない）" };
  if (!(await robotsAllowsRoot(u.origin))) return { pid, skip: "robots.txtで拒否" };
  let res;
  try { res = await get(u.href); } catch (e) { return { pid, skip: "サイトに接続できない" }; }
  if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) { try { res.body && res.body.cancel(); } catch (e) {} return { pid, skip: "ページを取得できない" }; }
  const html = await readText(res, 800000);
  let img = findImage(html);
  if (!img) return { pid, skip: "共有用画像なし" };
  try { img = new URL(img, res.url).href; } catch (e) { return { pid, skip: "画像URL不正" }; }
  if (img.startsWith("http://")) img = "https://" + img.slice(7); // 公開サイトは https のため http 画像は表示できない
  // 「画像なし」の代替画像やロゴはカード写真に向かないので除外
  const file = decodeURIComponent(new URL(img).pathname.split("/").pop() || "").toLowerCase();
  if (/no[-_]?image|noimg|dummy|placeholder|default|blank|spacer/.test(file)) return { pid, skip: "代替画像（画像なし）" };
  if (/logo|favicon|icon|apple-touch|site-?mark/.test(file)) return { pid, skip: "ロゴ画像" };
  if (!(await imageOk(img))) return { pid, skip: "画像を表示できない" };
  return { pid, img, src: host };
}

/* ---------- 実行 ---------- */
const results = []; let next = 0, done = 0;
async function worker() {
  while (next < sites.length) {
    const s = sites[next++];
    const r = await processSite(s).catch(e => ({ pid: s.pid, skip: "エラー" }));
    results.push(r); done++;
    if (done % 25 === 0 || done === sites.length) process.stdout.write(`  … ${done}/${sites.length}\n`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const images = Object.assign({}, prev.images || {});
const reasons = {};
for (const r of results) {
  if (r.img) images[r.pid] = { img: r.img, src: r.src, at: new Date().toISOString().slice(0, 10) };
  else { delete images[r.pid]; reasons[r.skip] = (reasons[r.skip] || 0) + 1; }
}
for (const pid of Object.keys(images)) if (excluded.has(pid.toLowerCase()) || excluded.has(images[pid].src)) delete images[pid];

fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), images }, null, 1) + "\n");
const got = results.filter(r => r.img).length;
console.log(`\n✅ 画像あり ${got}件 / ${results.length}件（アプリ全体では ${Object.keys(images).length}件）`);
Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`   ・${k}: ${n}件`));
console.log(`💾 ${path.relative(ROOT, OUT)} を更新しました`);

if (!flag("--keep") && !LIMIT) { fs.unlinkSync(input); console.log(`🗑  一覧ファイルを削除しました（${path.basename(input)}）`); }

if (flag("--publish")) {
  const git = (...a) => execFileSync("git", ["-C", ROOT, "-c", "user.name=tomi119000", "-c", "user.email=tomi119000@gmail.com", ...a], { stdio: "inherit" });
  try {
    git("add", "assets/site-images.json");
    git("commit", "-m", `Update site images (${got} found)`);
    git("push", "-q", "origin", "HEAD");
    console.log("🚀 公開しました（数分でサイトに反映されます）");
  } catch (e) { console.log("⚠️ 公開に失敗しました。変更が無いか、ネット接続を確認してください。"); }
}
