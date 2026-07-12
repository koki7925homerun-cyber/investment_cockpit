// 毎朝6時(JST)の回で「今日の10問」data/quiz.json を生成する。
// 中級〜上級のみ(用語の意味を直接聞く問題は禁止)。当日のbriefing.jsonを題材にした
// 時事問題を2〜3問含める。GitHub Models API (secrets.GITHUB_TOKEN, models: read) を使用。
// 生成・検証に失敗した場合は既存のquiz.jsonを変更せず正常終了する(コミットされない)。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const cut = (s, n) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return [...t].length <= n ? t : [...t].slice(0, n - 1).join("") + "…";
};
const BANNED = ["買うべき", "売るべき", "必ず上がる", "必ず下がる", "確実に儲", "全力で買", "全力で売", "今すぐ買", "今すぐ売"];
const clean = (s) => typeof s === "string" && s.trim() && !BANNED.some((w) => s.includes(w));

function todayJst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

let briefing = null;
try { briefing = JSON.parse(readFileSync("data/briefing.json", "utf8")); } catch (e) { /* なくても生成は続行 */ }
const newsBlock = (briefing?.items || [])
  .map((it) => `- ${it.title}: ${it.body}${it.soWhat ? ` / 示唆: ${it.soWhat}` : ""}`)
  .join("\n") || "(本日のニュース要約なし)";

const prompt = `あなたは日本の個人投資家向け教育クイズの出題者です。「今日の10問」を作成し、指定のJSONだけを出力してください。

本日の市場ニュース(時事問題の題材):
${newsBlock}

出題ルール:
- 難易度は中級〜上級のみ。用語の意味を直接聞く問題(「◯◯とは?」)は禁止
- 問題タイプを混ぜる:
  (a) 状況判断: 知識を状況に当てはめる(例: 利下げ局面で一般に追い風になりにくいのは?)
  (b) 数字の感覚: 複利・利回り・下落からの回復率・リバランス・ポートフォリオ計算など、概算暗算で解ける計算問題
  (c) シナリオ思考: 複合状況での相対比較(例: スタグフレーション下で相対的に強い組合せは?)
  (d) 時事問題: 上記の本日のニュースを題材に、投資判断への示唆を問う問題を2〜3問(ニュースの細かい事実の暗記ではなく「このニュースは一般に何を意味するか」を問う)
- 選択肢は4つ。「明らかな不正解」を作らず、知識がないと迷うもっともらしい選択肢にする
- 正解の位置(answer)は0〜3にばらけさせる
- 断定的な売買推奨になる問題・選択肢は禁止。「一般に」「定石として」の表現を使う
- why: 解説2〜3文。正解の理由に加えて、主な誤答選択肢がなぜ違うかまで説明する

出力形式(このJSONオブジェクトのみ、questionsは必ず10問):
{"questions":[{"q":"問題文","opts":["A","B","C","D"],"answer":2,"why":"解説"}]}`;

async function generate() {
  const res = await fetch("https://models.github.ai/inference/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`models API HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content);
  const qs = parsed.questions;
  if (!Array.isArray(qs) || qs.length !== 10) throw new Error(`need 10 questions, got ${qs?.length}`);
  const date = todayJst();
  return qs.map((raw, idx) => {
    if (!clean(raw.q) || !clean(raw.why) || [...(raw.why || "")].length < 20) throw new Error(`bad q/why #${idx + 1}`);
    if (!Array.isArray(raw.opts) || raw.opts.length !== 4 || raw.opts.some((o) => !clean(o))) throw new Error(`bad opts #${idx + 1}`);
    if (new Set(raw.opts.map((o) => o.trim())).size !== 4) throw new Error(`duplicate opts #${idx + 1}`);
    if (!Number.isInteger(raw.answer) || raw.answer < 0 || raw.answer > 3) throw new Error(`bad answer #${idx + 1}`);
    // 正解位置の偏り対策として選択肢を並べ替える
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    return {
      id: `${date}-${String(idx + 1).padStart(2, "0")}`,
      q: cut(raw.q, 140),
      opts: order.map((i) => cut(raw.opts[i], 70)),
      answer: order.indexOf(raw.answer),
      why: cut(raw.why, 220),
    };
  });
}

let questions;
try {
  try {
    questions = await generate();
  } catch (e) {
    console.warn(`first attempt failed (${e.message}), retrying once...`);
    questions = await generate();
  }
} catch (e) {
  console.warn(`quiz generation failed, keeping quiz.json unchanged: ${e.message}`);
  process.exit(0);
}

mkdirSync("data", { recursive: true });
writeFileSync("data/quiz.json", JSON.stringify({ date: todayJst(), questions }, null, 2) + "\n");
console.log(`wrote data/quiz.json (${questions.length} questions for ${todayJst()})`);
