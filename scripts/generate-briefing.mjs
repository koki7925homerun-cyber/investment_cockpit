// NHKの経済・国際RSSから投資家向け朝ブリーフィング data/briefing.json を生成する。
//
// ANTHROPIC_API_KEY があればClaude APIで要約し、なければ内蔵ルールエンジンで
// 生成する(GitHub Modelsは2026-07-30に終了したため、キー不要のLLMは存在しない)。
// どちらの経路でも lead / body / soWhat が埋まった有効なJSONを必ず出力する。
import { writeFileSync, mkdirSync } from "node:fs";
import { askJson, isAvailable, providerNote } from "./lib/llm.mjs";
import { ruleAnnotate, ruleLead } from "./lib/rules.mjs";

const FEEDS = [
  { cat: "経済", url: "https://www.nhk.or.jp/rss/news/cat5.xml" },
  { cat: "国際", url: "https://www.nhk.or.jp/rss/news/cat6.xml" },
];
const FRESH_WINDOW_MS = 36 * 60 * 60 * 1000; // 直近36時間を「新しい」とみなす

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
  const res = await fetch(url, { headers: { "user-agent": "briefing-bot" } });
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
const safeText = (s, n) => {
  const t = cut(s, n);
  return BANNED.some((w) => t.includes(w)) ? "" : t;
};
const strList = (a, n, len) =>
  (Array.isArray(a) ? a : []).filter((x) => typeof x === "string" && x.trim()).slice(0, n).map((x) => cut(x, len));

function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), generatedAt: new Date().toISOString() };
}

// 新しい順に並べ、直近36時間の記事を優先して候補を作る。
// (NHKのRSSには数日前の記事が残ることがあり、放置すると古い記事が選ばれる)
// 経済と国際のフィードには同じ記事が載ることがあるため、見出しで重複を除く。
const titleKey = (s) => (s || "").replace(/[\s　「」【】]/g, "").slice(0, 18);
function rankCandidates(feeds) {
  const all = feeds.flat().sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const unique = all.filter((n) => {
    const k = titleKey(n.title);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const fresh = unique.filter((n) => Date.now() - n.ts < FRESH_WINDOW_MS);
  return (fresh.length >= 6 ? fresh : unique).slice(0, 24);
}

// ---- ルールベース生成(LLMなしでも実用的な内容を出す) ----
function ruleBriefing(candidates) {
  const { date, generatedAt } = nowJst();
  // ルールに該当する記事(=投資家に関係する記事)を優先して4件選ぶ
  const scored = candidates.map((n) => ({ n, ann: ruleAnnotate(`${n.title} ${n.description || ""}`) }));
  // 同じテーマ(同じルール)ばかりにならないよう、まず1テーマ1件で拾い、
  // 4件に満たなければ残りで埋める。
  const usedTheme = new Set();
  const primary = [];
  const spare = [];
  for (const s of scored) {
    if (!s.ann) { spare.push(s); continue; }
    const theme = s.ann.soWhat;
    if (usedTheme.has(theme)) { spare.push(s); continue; }
    usedTheme.add(theme);
    primary.push(s);
  }
  const picked = [...primary, ...spare].slice(0, 4);

  return {
    date,
    generatedAt,
    source: "rules",
    lead: cut(ruleLead(picked.map((p) => p.n)), 40),
    events: [],
    items: picked.map(({ n, ann }) => ({
      cat: n.cat,
      title: cut(n.title, 25),
      body: cut(n.description || n.title, 90),
      impact: ann?.impact ?? "mixed",
      link: n.link,
      terms: [],
      soWhat: ann?.soWhat ?? "投資家への影響は個別事情によるため、続報を確認する材料として扱うのが無難です。",
      assets: { up: ann?.assets.up ?? [], down: ann?.assets.down ?? [] },
      horizon: ann?.horizon ?? "short",
      watch: ann?.watch ?? "",
    })),
  };
}

// ---- LLM生成 ----
function validate(b, allowedLinks) {
  if (!b || typeof b !== "object") return false;
  if (!Array.isArray(b.items) || b.items.length !== 4) return false;
  for (const it of b.items) {
    if (!it || typeof it.title !== "string" || typeof it.body !== "string") return false;
    if (typeof it.soWhat !== "string" || !it.soWhat.trim()) return false;
    if (!["up", "down", "mixed"].includes(it.impact)) return false;
    if (!allowedLinks.has(it.link)) return false;
    if (!Array.isArray(it.terms)) return false;
    for (const t of it.terms) {
      if (!t || typeof t.word !== "string" || typeof t.def !== "string") return false;
    }
  }
  return typeof b.lead === "string" && b.lead.trim().length > 0;
}

function tighten(b) {
  const { date, generatedAt } = nowJst();
  return {
    date,
    generatedAt,
    source: "ai",
    lead: cut(b.lead, 40),
    events: strList(b.events, 3, 40),
    items: b.items.map((it) => ({
      cat: cut(it.cat || "経済", 10),
      title: cut(it.title, 25),
      body: cut(it.body, 90),
      impact: it.impact,
      link: it.link,
      terms: (it.terms || []).slice(0, 3).map((t) => ({ word: cut(t.word, 20), def: cut(t.def, 40) })),
      soWhat: safeText(it.soWhat, 110),
      assets: { up: strList(it.assets?.up, 3, 15), down: strList(it.assets?.down, 3, 15) },
      horizon: ["short", "mid", "long"].includes(it.horizon) ? it.horizon : "short",
      watch: safeText(it.watch, 45),
    })),
  };
}

async function aiBriefing(candidates) {
  const list = candidates
    .map((c, i) => `${i + 1}. [${c.cat}] ${c.title} | ${c.description} | ${c.link}`)
    .join("\n");
  const prompt = `あなたは日本の個人投資家向けの朝ブリーフィング編集者です。
以下のNHKニュース一覧から、投資家(株式・為替・金利に関心)に最も重要な4件を選び、指定のJSONだけを出力してください。

ルール:
- 一覧は新しい順に並んでいます。直近のニュースを優先して選んでください
- 「事実」と「解釈」を区別する。body=記事から読み取れる事実の要約、soWhat=あなたの解釈(投資家への示唆)
- 記事の文章をそのまま写さず、必ず自分の言葉で要約する
- soWhatは「このニュースが読者のポートフォリオに何を意味しうるか」を1〜2文で。断定的な売買推奨(買うべき/売るべき等)は書かず、「〜に注意」「〜が判断材料」など判断材料の提示にとどめる
- linkは一覧に記載されたURLをそのまま使う(変更・創作禁止)
- lead: 今日の市場を一言で40字以内
- events: 今日〜今週の注目経済イベントを最大3件(例: 日銀金融政策決定会合、米CPI発表)。ニュースから読み取れるもの・一般に知られる定例イベントのみ。日付が不確かなら「今週」等と表現し、創作しない。該当なしなら空配列
- 各item:
  - cat=分類(経済/国際など短く), title=見出し25字以内, body=事実の要約2文90字以内
  - impact=up|down|mixed(市場全体への影響方向)
  - soWhat=投資家への示唆1〜2文100字以内
  - assets={"up":[恩恵を受けやすい資産・セクター2〜3個],"down":[打撃を受けやすいもの2〜3個]}(各要素は「日本株」「輸出企業」「金」など15字以内)
  - horizon=short|mid|long(影響が効く時間軸: short=〜1年, mid=1〜5年, long=5年超)
  - watch=次に確認すべき指標・日付・イベントを1つ40字以内(例:「来週の米CPI」「日銀総裁会見」)
  - terms=初心者が知らなそうな重要用語1〜2個(defは40字以内の平易な説明)

出力形式(このJSONオブジェクトのみ):
{"lead":"...","events":["..."],"items":[{"cat":"...","title":"...","body":"...","impact":"mixed","soWhat":"...","assets":{"up":["..."],"down":["..."]},"horizon":"short","watch":"...","link":"...","terms":[{"word":"...","def":"..."}]}]}

ニュース一覧(新しい順):
${list}`;

  const parsed = await askJson(prompt, { maxTokens: 12000 });
  const allowed = new Set(candidates.map((c) => c.link));
  if (!validate(parsed, allowed)) throw new Error("AI output failed validation");
  return tighten(parsed);
}

// ---- main ----
let feeds;
try {
  feeds = await Promise.all(FEEDS.map(fetchFeed));
} catch (e) {
  console.error(`RSS fetch failed, keeping briefing.json unchanged: ${e.message}`);
  process.exit(0);
}
const candidates = rankCandidates(feeds);
if (!candidates.length) {
  console.error("RSS items empty, keeping briefing.json unchanged");
  process.exit(0);
}

console.log(`provider: ${providerNote()}`);
let briefing;
if (isAvailable()) {
  try {
    briefing = await aiBriefing(candidates);
    console.log("briefing generated via Claude API");
  } catch (e) {
    console.warn(`AI generation failed, using rule-based fallback: ${e.message}`);
    briefing = ruleBriefing(candidates);
  }
} else {
  briefing = ruleBriefing(candidates);
  console.log("briefing generated via built-in rule engine");
}

mkdirSync("data", { recursive: true });
writeFileSync("data/briefing.json", JSON.stringify(briefing, null, 2) + "\n");
console.log(`wrote data/briefing.json (source=${briefing.source}, lead="${briefing.lead}")`);
