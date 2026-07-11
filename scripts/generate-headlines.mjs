// NHK経済・国際RSSの最新10件に投資家向け注釈(soWhat/assets/horizon/impact)を付けた
// data/headlines.json を生成する。3時間おきに実行される想定。
// GitHub Models無料枠を節約するため、前回のheadlines.jsonに既にある記事(link一致)は
// 再生成せずそのまま引き継ぎ、新規記事のみAIに問い合わせる。
// AI呼び出しが失敗しても、キャッシュ分だけで有効なJSONを必ず出力する。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const FEEDS = [
  { cat: "経済", url: "https://www.nhk.or.jp/rss/news/cat5.xml" },
  { cat: "国際", url: "https://www.nhk.or.jp/rss/news/cat6.xml" },
];
const MAX_ITEMS = 10;   // 注釈対象: フィード横断の最新10件
const MAX_KEEP = 30;    // キャッシュとして保持する最大件数(フィードの入れ替わり対策)

const decode = (s) =>
  (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};

async function fetchFeed({ cat, url }) {
  const res = await fetch(url, { headers: { "user-agent": "headlines-bot" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    items.push({
      cat,
      title: tag(it, "title"),
      link: tag(it, "link"),
      description: tag(it, "description"),
      ts: new Date(tag(it, "pubDate")).getTime() || 0,
    });
  }
  return items.filter((i) => i.title && i.link);
}

const cut = (s, n) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return [...t].length <= n ? t : [...t].slice(0, n - 1).join("") + "…";
};
const BANNED = ["買うべき", "売るべき", "必ず上がる", "必ず下がる", "確実に儲", "全力で買", "全力で売", "今すぐ買", "今すぐ売"];
const clean = (s) => typeof s === "string" && s.trim() && !BANNED.some((w) => s.includes(w));
const strList = (a, n, len) =>
  (Array.isArray(a) ? a : []).filter((x) => typeof x === "string" && x.trim()).slice(0, n).map((x) => cut(x, len));

function normalize(a) {
  return {
    link: a.link,
    soWhat: cut(a.soWhat, 80),
    assets: { up: strList(a.assets?.up, 3, 15), down: strList(a.assets?.down, 3, 15) },
    horizon: ["short", "mid", "long"].includes(a.horizon) ? a.horizon : "short",
    impact: ["up", "down", "mixed"].includes(a.impact) ? a.impact : "mixed",
  };
}

async function annotate(newsItems) {
  const list = newsItems
    .map((n, i) => `${i + 1}. [${n.cat}] ${n.title} | ${n.description} | ${n.link}`)
    .join("\n");
  const prompt = `あなたは日本の個人投資家向けニュース注釈者です。以下の各ニュースに投資家向けの注釈を付け、指定のJSONだけを出力してください。

ルール:
- soWhat: このニュースが投資家のポートフォリオに何を意味しうるかを1文60字以内。断定的な売買推奨(買うべき/売るべき等)は書かず、「〜に注意」「〜が判断材料」など判断材料の提示にとどめる
- assets: {"up":[恩恵を受けやすい資産・セクター1〜3個],"down":[打撃を受けやすいもの1〜3個]}(各15字以内)。判断が難しければ空配列でよい
- horizon: 影響が効く時間軸 short(〜1年)|mid(1〜5年)|long(5年超)
- impact: 市場全体への影響方向 up|down|mixed
- link: 一覧のURLをそのまま使う(変更禁止)。全件に注釈を付ける

出力形式(このJSONオブジェクトのみ):
{"annotations":[{"link":"...","soWhat":"...","assets":{"up":["..."],"down":["..."]},"horizon":"short","impact":"mixed"}]}

ニュース一覧:
${list}`;

  const res = await fetch("https://models.github.ai/inference/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`models API HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content);
  const allowed = new Set(newsItems.map((n) => n.link));
  const out = [];
  for (const a of parsed.annotations || []) {
    if (!a || !allowed.has(a.link) || !clean(a.soWhat)) continue; // 不正な1件は捨てて他は生かす
    out.push(normalize(a));
  }
  return out;
}

// ---- main ----
let feeds;
try {
  feeds = await Promise.all(FEEDS.map(fetchFeed));
} catch (e) {
  console.warn(`RSS fetch failed, keeping headlines.json unchanged: ${e.message}`);
  process.exit(0);
}
const current = feeds.flat().sort((a, b) => b.ts - a.ts).slice(0, MAX_ITEMS);
if (!current.length) {
  console.warn("RSS items empty, keeping headlines.json unchanged");
  process.exit(0);
}

let prev = [];
try {
  prev = JSON.parse(readFileSync("data/headlines.json", "utf8")).items || [];
} catch (e) { /* 初回実行 */ }
const prevMap = new Map(prev.filter((a) => a && a.link).map((a) => [a.link, a]));

const fresh = current.filter((n) => !prevMap.has(n.link));
let aiMap = new Map();
if (fresh.length) {
  try {
    aiMap = new Map((await annotate(fresh)).map((a) => [a.link, a]));
    console.log(`annotated ${aiMap.size}/${fresh.length} new items via GitHub Models API`);
  } catch (e) {
    console.warn(`AI annotation failed, serving cache only: ${e.message}`);
  }
} else {
  console.log("no new items; reusing cache entirely");
}

const items = [];
for (const n of current) {
  const a = prevMap.get(n.link) || aiMap.get(n.link);
  if (a) items.push(normalize(a));
}
// 現在の10件に入っていない過去の注釈も、フィードの入れ替わりに備えて上限まで保持
for (const a of prev) {
  if (items.length >= MAX_KEEP) break;
  if (a && a.link && !items.some((x) => x.link === a.link)) items.push(normalize(a));
}

mkdirSync("data", { recursive: true });
writeFileSync("data/headlines.json", JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2) + "\n");
console.log(`wrote data/headlines.json (${items.length} annotations)`);
