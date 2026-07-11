// NHKの経済・国際RSSから投資家向け朝ブリーフィング data/briefing.json を生成する。
// GitHub Models API (secrets.GITHUB_TOKEN, models: read) で要約し、
// 失敗時はRSS先頭4件から機械的に組み立てるフォールバックで必ず有効なJSONを出力する。
import { writeFileSync, mkdirSync } from "node:fs";

const FEEDS = [
  { cat: "経済", url: "https://www.nhk.or.jp/rss/news/cat5.xml" },
  { cat: "国際", url: "https://www.nhk.or.jp/rss/news/cat6.xml" },
];

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
      pubDate: tag(it, "pubDate"),
    });
  }
  return items.filter((i) => i.title && i.link);
}

const cut = (s, n) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return [...t].length <= n ? t : [...t].slice(0, n - 1).join("") + "…";
};

function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), generatedAt: new Date().toISOString() };
}

const BANNED = ["買うべき", "売るべき", "必ず上がる", "必ず下がる", "確実に儲", "全力で買", "全力で売", "今すぐ買", "今すぐ売"];
const safeText = (s, n) => {
  const t = cut(s, n);
  return BANNED.some((w) => t.includes(w)) ? "" : t;
};

function fallbackBriefing(feeds) {
  // 経済・国際から交互に先頭記事を取り、機械的に4件組み立てる(創作はしない)
  const picked = [];
  for (let i = 0; picked.length < 4 && i < 10; i++) {
    for (const items of feeds) {
      if (items[i] && picked.length < 4) picked.push(items[i]);
    }
  }
  const { date, generatedAt } = nowJst();
  return {
    date,
    generatedAt,
    lead: cut("自動要約が利用できないため主要見出しのみ表示中", 40),
    events: [],
    items: picked.map((p) => ({
      cat: p.cat,
      title: cut(p.title, 25),
      body: cut(`${p.description || p.title}(NHK配信の見出し情報)`, 90),
      impact: "mixed",
      link: p.link,
      terms: [],
      soWhat: "",
      assets: { up: [], down: [] },
      horizon: "short",
      watch: "",
    })),
  };
}

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
  return typeof b.lead === "string";
}

function tighten(b) {
  const { date, generatedAt } = nowJst();
  const strList = (a, n, len) =>
    (Array.isArray(a) ? a : []).filter((x) => typeof x === "string" && x.trim()).slice(0, n).map((x) => cut(x, len));
  return {
    date,
    generatedAt,
    lead: cut(b.lead, 40),
    events: strList(b.events, 3, 40),
    items: b.items.map((it) => ({
      cat: cut(it.cat || "経済", 10),
      title: cut(it.title, 25),
      body: cut(it.body, 90),
      impact: it.impact,
      link: it.link,
      terms: (it.terms || []).slice(0, 3).map((t) => ({
        word: cut(t.word, 20),
        def: cut(t.def, 40),
      })),
      soWhat: safeText(it.soWhat, 110),
      assets: {
        up: strList(it.assets?.up, 3, 15),
        down: strList(it.assets?.down, 3, 15),
      },
      horizon: ["short", "mid", "long"].includes(it.horizon) ? it.horizon : "short",
      watch: safeText(it.watch, 45),
    })),
  };
}

async function aiBriefing(feeds) {
  const candidates = feeds.flat().slice(0, 30);
  const list = candidates
    .map((c, i) => `${i + 1}. [${c.cat}] ${c.title} | ${c.description} | ${c.link}`)
    .join("\n");
  const prompt = `あなたは日本の個人投資家向けの朝ブリーフィング編集者です。
以下のNHKニュース一覧から、投資家(株式・為替・金利に関心)に最も重要な4件を選び、指定のJSONだけを出力してください。

ルール:
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
  - watch=次に確認すべき指標・日付・イベントを1つ40字以内(例: 「来週の米CPI」「日銀総裁会見」)
  - terms=初心者が知らなそうな重要用語1〜2個(defは40字以内の平易な説明)

出力形式(このJSONオブジェクトのみ):
{"lead":"...","events":["..."],"items":[{"cat":"...","title":"...","body":"...","impact":"mixed","soWhat":"...","assets":{"up":["..."],"down":["..."]},"horizon":"short","watch":"...","link":"...","terms":[{"word":"...","def":"..."}]}]}

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
  const content = data.choices?.[0]?.message?.content;
  const parsed = JSON.parse(content);
  const allowed = new Set(candidates.map((c) => c.link));
  if (!validate(parsed, allowed)) throw new Error("AI output failed validation");
  return tighten(parsed);
}

const feeds = await Promise.all(FEEDS.map(fetchFeed));
if (feeds.flat().length === 0) throw new Error("RSS items empty");

let briefing;
try {
  briefing = await aiBriefing(feeds);
  console.log("briefing generated via GitHub Models API");
} catch (e) {
  console.warn(`AI generation failed, using fallback: ${e.message}`);
  briefing = fallbackBriefing(feeds);
}

mkdirSync("data", { recursive: true });
writeFileSync("data/briefing.json", JSON.stringify(briefing, null, 2) + "\n");
console.log("wrote data/briefing.json");
