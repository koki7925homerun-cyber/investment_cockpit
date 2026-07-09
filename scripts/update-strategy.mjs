// 週次で data/strategy.json の「骨子(thesis)」と「シナリオ確率(prob)」を
// 最新のNHK経済・国際ニュースを踏まえて見直す。
// GitHub Models API (secrets.GITHUB_TOKEN, models: read) を使用。
// 更新対象は thesis / prob / note / updatedAt のみで、施策リストや文言構造は変更しない。
// AI呼び出しに失敗した場合はファイルを変更せず正常終了する(コミットはスキップされる)。
import { readFileSync, writeFileSync } from "node:fs";

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
  const res = await fetch(url, { headers: { "user-agent": "strategy-bot" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    items.push({ cat, title: tag(it, "title"), description: tag(it, "description") });
  }
  return items.filter((i) => i.title);
}

const cut = (s, n) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return [...t].length <= n ? t : [...t].slice(0, n - 1).join("") + "…";
};

const BANNED = ["買うべき", "売るべき", "必ず上がる", "必ず下がる", "確実に儲", "全力で買", "全力で売", "今すぐ買", "今すぐ売"];
const clean = (s) => typeof s === "string" && s.trim() && !BANNED.some((w) => s.includes(w));

async function proposeUpdate(strategy, news) {
  const list = news.map((n) => `- [${n.cat}] ${n.title}: ${n.description}`).join("\n");
  const cur = {
    horizons: Object.fromEntries(
      Object.entries(strategy.horizons).map(([k, v]) => [k, { label: v.label, thesis: v.thesis }])
    ),
    scenarios: strategy.scenarios.map((s) => ({ key: s.key, label: s.label, title: s.title, d: s.d, prob: s.prob })),
  };
  const prompt = `あなたは日本の個人投資家向け教育アプリの編集者です。週次レビューとして、投資戦略の「骨子」と「シナリオ確率」を最新ニュースを踏まえて見直してください。

現在の戦略(骨子と確率のみ抜粋):
${JSON.stringify(cur, null, 1)}

今週のニュース見出し(NHK):
${list}

ルール:
- 各時間軸(short/mid/long)のthesis(骨子)を見直す。大筋が変わらなければ現状維持でよいが、ニュースで前提が動いた部分は反映する。各thesisは60字以内、方針の要約であり断定的な売買推奨(買うべき/売るべき等)は書かない
- 3つのシナリオ(base/bull/bear)の発生確率probを見直す。整数で合計100
- note: 今回の見直しの要点を50字以内で

次のJSONオブジェクトだけを出力:
{"horizons":{"short":{"thesis":"..."},"mid":{"thesis":"..."},"long":{"thesis":"..."}},"scenarios":[{"key":"base","prob":50},{"key":"bull","prob":25},{"key":"bear","prob":25}],"note":"..."}`;

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
  const p = JSON.parse(data.choices?.[0]?.message?.content);

  // 検証: thesisは3本とも妥当な文字列、probは合計がほぼ100
  for (const k of ["short", "mid", "long"]) {
    if (!clean(p.horizons?.[k]?.thesis)) throw new Error(`invalid thesis: ${k}`);
  }
  const probs = new Map((p.scenarios || []).map((s) => [s.key, s.prob]));
  let sum = 0;
  for (const k of ["base", "bull", "bear"]) {
    const v = probs.get(k);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`invalid prob: ${k}`);
    sum += v;
  }
  if (sum < 90 || sum > 110) throw new Error(`prob sum out of range: ${sum}`);
  return p;
}

const strategy = JSON.parse(readFileSync("data/strategy.json", "utf8"));

let news;
try {
  news = (await Promise.all(FEEDS.map(fetchFeed))).flat().slice(0, 30);
  if (news.length === 0) throw new Error("RSS items empty");
} catch (e) {
  console.warn(`RSS fetch failed, keeping strategy.json unchanged: ${e.message}`);
  process.exit(0);
}

let update;
try {
  update = await proposeUpdate(strategy, news);
} catch (e) {
  console.warn(`AI review failed, keeping strategy.json unchanged: ${e.message}`);
  process.exit(0);
}

// 許可フィールドのみマージ(thesis / prob / note / updatedAt)
for (const k of ["short", "mid", "long"]) {
  strategy.horizons[k].thesis = cut(update.horizons[k].thesis, 70);
}
let total = 0;
for (const s of strategy.scenarios) {
  const v = update.scenarios.find((x) => x.key === s.key)?.prob;
  s.prob = Math.round(v);
  total += s.prob;
}
if (total !== 100) strategy.scenarios[0].prob += 100 - total; // 丸め誤差はベースで吸収
if (clean(update.note)) strategy.note = cut(update.note, 60);
strategy.updatedAt = new Date().toISOString();

writeFileSync("data/strategy.json", JSON.stringify(strategy, null, 2) + "\n");
console.log("updated data/strategy.json:", strategy.note,
  strategy.scenarios.map((s) => `${s.key}=${s.prob}%`).join(" "));
