# chat-sensei

Twitch のライブチャットを **生IRC / 翻訳 / 解説** の3カラムで読む、サーバーを持たないクライアントサイド専用の語学学習ツールです。

- 左列: 匿名接続した Twitch IRC の発言をそのまま表示します(表示名の色・emote画像付き)
- 中央列: 発言の翻訳を表示します
- 右列: 発言の解説を必要に応じて生成して表示します
- 翻訳列・解説列はデフォルトでぼかして表示し、トグルで解除できます(まず自力で読み、答え合わせに使う想定)

AI推論は Chrome 内蔵の Gemini Nano(Prompt API)でブラウザ内に完結し、ログイン・バックエンド・外部APIキーは不要です。

> 現在はコンセプト刷新直後で、翻訳・解説の生成処理と単語帳などの周辺機能は未実装です。

## 開発

```bash
npm install
npm run dev         # http://localhost:3000
npm test            # Vitest
npm run lint
npm run type-check
```
