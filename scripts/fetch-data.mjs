// scripts/fetch-data.mjs
// 毎朝GitHub Actionsが実行: ニュースRSSと価格を取得して data/ に書き出す
// 依存パッケージなし(Node 20+ の標準fetchのみ)
import { writeFileSync, mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });

const FEEDS = [
  { name: "NHK 経済", url: "https://www.nhk.or.jp/rss/news/cat5.xml" },
  { name: "NHK 国際", url: "https://www.nhk.or.jp/rss/news/cat6.xml" },
];

// --- 超軽量RSSパーサ(RSS2.0想定) ---
function parseRSS(xml, srcName) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const b of blocks.slice(0, 8)) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m
        ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim()
        : "";
    };
    const title = pick("title");
    if (!title) continue;
    items.push({
      src: srcName,
      title,
      link: pick("link"),
      desc: pick("description").slice(0, 160),
      date: new Date(pick("pubDate") || Date.now()).toISOString(),
    });
  }
  return items;
}

async function safe(name, fn) {
  try { return await fn(); }
  catch (e) { console.error(`[skip] ${name}: ${e.message}`); return null; }
}

// --- ニュース ---
const newsResults = await Promise.all(
  FEEDS.map((f) =>
    safe(f.name, async () => {
      const r = await fetch(f.url, { headers: { "User-Agent": "cockpit-bot" } });
      return parseRSS(await r.text(), f.name);
    })
  )
);
const news = newsResults
  .filter(Boolean)
  .flat()
  .sort((a, b) => new Date(b.date) - new Date(a.date))
  .slice(0, 12);

writeFileSync("data/news-raw.json", JSON.stringify({ fetchedAt: new Date().toISOString(), items: news }, null, 2));
console.log(`news: ${news.length}件`);

// --- 価格(キー不要API) ---
const prices = [];

await safe("coingecko", async () => {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=jpy&include_24hr_change=true");
  const j = await r.json();
  for (const [id, label] of [["bitcoin", "ビットコイン"], ["ethereum", "イーサリアム"]]) {
    const c = j[id];
    prices.push({
      name: label,
      price: "¥" + Math.round(c.jpy).toLocaleString("ja-JP"),
      chg: (c.jpy_24h_change >= 0 ? "+" : "") + c.jpy_24h_change.toFixed(1) + "% (24h)",
      dir: c.jpy_24h_change >= 0 ? "up" : "down",
    });
  }
});

await safe("frankfurter", async () => {
  const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=JPY");
  const j = await r.json();
  prices.push({ name: "ドル円 (USD/JPY)", price: j.rates.JPY.toFixed(2) + " 円", chg: "ECB日次レート", dir: "flat" });
});

await safe("gold", async () => {
  const r = await fetch("https://api.gold-api.com/price/XAU");
  const j = await r.json();
  prices.push({ name: "金 (XAU/USD)", price: "$" + Math.round(j.price).toLocaleString("ja-JP"), chg: "スポット", dir: "flat" });
});

writeFileSync("data/market.json", JSON.stringify({ fetchedAt: new Date().toISOString(), prices }, null, 2));
console.log(`prices: ${prices.length}件`);
