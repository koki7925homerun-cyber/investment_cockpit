// LLMプロバイダの抽象化。
//
// 背景: GitHub Models (models.github.ai) は2026年7月30日に完全終了し、
// 現在はHTTP 410を返す。無料・キー不要のLLMはもう存在しないため、
//   - ANTHROPIC_API_KEY が設定されていればClaude APIを使う
//   - 未設定なら isAvailable() が false を返し、各スクリプトは
//     内蔵ルールベースのフォールバックに切り替える
// という構成にしている。キー未設定でもワークフローは正常終了する。
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-5";
const ANTHROPIC_VERSION = "2023-06-01";

export const isAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY);

export const providerNote = () =>
  isAvailable()
    ? `Claude API (${MODEL})`
    : "LLM未設定(ANTHROPIC_API_KEYがないためルールベースで生成)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// レスポンス本文からJSONオブジェクトを取り出す(```json フェンス等に耐える)
function extractJson(text) {
  const t = (text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object in response");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Claude APIを1回呼び出し、JSONオブジェクトを返す。
 * 429・5xx・ネットワークエラーは指数バックオフで再試行する。
 */
export async function askJson(prompt, { maxTokens = 8000, effort = "medium", retries = 3 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = lastErr?.retryAfterMs ?? Math.min(2 ** attempt * 1000, 30000);
      console.warn(`  retry ${attempt}/${retries} after ${Math.round(wait / 1000)}s (${lastErr?.message})`);
      await sleep(wait);
    }
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        // claude-opus-5では思考がデフォルトで有効。max_tokensは思考+本文の
        // 合計上限なので、出力が小さくても余裕をもたせる。
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          output_config: { effort },
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        // 429と5xxのみ再試行対象。4xx(認証・リクエスト不正)は即座に諦める。
        err.retryable = res.status === 429 || res.status >= 500;
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
        if (!err.retryable) throw err;
        lastErr = err;
        continue;
      }

      const data = await res.json();
      // 安全性分類器による拒否は成功レスポンスとして返る。contentを読む前に確認する。
      // 同じ入力なら結果も同じなので再試行しない。
      if (data.stop_reason === "refusal") {
        const err = new Error(`request declined by safety classifier (${data.stop_details?.category ?? "unknown"})`);
        err.retryable = false;
        throw err;
      }
      if (data.stop_reason === "max_tokens") {
        throw new Error("response truncated (max_tokens reached) — raise maxTokens");
      }
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      return extractJson(text);
    } catch (e) {
      if (e.retryable === false) throw e;
      lastErr = e;
      if (attempt === retries) throw new Error(`LLM call failed after ${retries + 1} attempts: ${e.message}`);
    }
  }
  throw lastErr;
}
