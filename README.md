# 投資コックピット — 毎朝自動更新版

毎朝6時(日本時間)にGitHub Actionsが自動実行し、AIブリーフィングを生成してアプリに反映します。

- **ホスティング**: GitHub Pages(無料)
- **自動実行**: GitHub Actions(公開リポジトリなら無料)
- **AI生成**: Claude Code + あなたのClaude Pro/Maxプランの利用枠(API課金なし)
- **ニュース/価格**: 無料の公開RSS・公開API

## セットアップ手順(初回のみ・約15分)

### 1. リポジトリを作る
1. GitHubにログインし、新規リポジトリを作成(**Public**にすること — Actionsが無料無制限になる)
2. このフォルダの中身(`index.html`, `scripts/`, `.github/`, `data/`)をすべてアップロード
   - Web画面なら「Add file → Upload files」でフォルダごとドラッグ&ドロップ

### 2. GitHub Pagesを有効化
1. リポジトリの **Settings → Pages**
2. Source: 「Deploy from a branch」/ Branch: `main` / フォルダ: `/ (root)` → Save
3. 数分後に `https://あなたのID.github.io/リポジトリ名/` でアプリが公開される

### 3. Claude Codeのトークンを登録(AI自動生成に必要)
1. 自分のPCでClaude Codeを開き、次を実行:
   ```
   claude setup-token
   ```
   ブラウザで認証すると `sk-ant-oat01-...` 形式の長期トークンが発行される
   (これはあなたのPro/Maxプランに紐づくトークンで、消費されるのはプランの利用枠。API課金は発生しない)
2. リポジトリの **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `CLAUDE_CODE_OAUTH_TOKEN`
   - Secret: 発行されたトークンを貼り付け → Add secret

### 4. 動作確認
1. リポジトリの **Actions** タブ → 「daily-update」→ **Run workflow** で手動実行
2. 成功すると `data/briefing.json` がコミットされる
3. アプリを開くと最上部に「AI BRIEFING — 毎朝6時 自動生成」が表示される

### 5. スマホでアプリ化
公開URLをiPhoneのSafariで開き、共有 → **ホーム画面に追加**。
以後は毎朝、開くだけでその日のブリーフィングが表示されます。

## 仕組み

```
毎朝 6:00 JST (cron)
  │
  ├─ scripts/fetch-data.mjs
  │    NHKニュースRSS + CoinGecko/ECB/gold-api → data/news-raw.json, data/market.json
  │
  ├─ Claude Code (anthropics/claude-code-action)
  │    news-raw.json を読み、4本の要約+影響判定+用語解説 → data/briefing.json
  │    認証: CLAUDE_CODE_OAUTH_TOKEN (Proプランの枠を消費)
  │
  └─ git commit & push → GitHub Pages に即反映
```

## カスタマイズ

- **実行時刻**: `.github/workflows/daily.yml` の `cron: "0 21 * * *"` を変更(UTC表記。JST-9時間)
- **1日2回更新**: cron行を追加(例: `"0 3 * * *"` で12:00 JSTにも実行)。Proプランの枠消費が倍になる点に注意
- **ニュースソース**: `scripts/fetch-data.mjs` の `FEEDS` にRSS URLを追加
- **ブリーフィングの口調・本数**: `daily.yml` 内のpromptを編集

## 注意事項

- Publicリポジトリは中身が誰でも見られます。**トークンはSecretsにのみ**保存し、コードに直書きしないでください(この構成では直書き箇所はありません)
- トークンはClaude Codeからログアウトすると無効になることがあります。その場合は `claude setup-token` で再発行してSecretを更新
- 1日1回のブリーフィング生成が消費する枠はごくわずかですが、Proプランの利用上限(5時間ごとのリセット)と共有です
- 本アプリは教育目的の情報整理ツールであり、投資助言ではありません
