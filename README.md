# chat-sensei

Twitch の実況チャットを教材にする、サーバーを持たないクライアントサイド専用の語学学習ツールです。

視聴中に流れてくる生きた発言(スラング・略語・ネットミーム)をその場でクリックすると、Chrome 内蔵の Gemini Nano(Prompt API)が学ぶ言語と解説言語の設定に応じて構造化された解説を生成します。気になった語句はワンクリックで単語帳に保存でき、SM-2 間隔反復アルゴリズムによる復習クイズで定着させられます。

ログイン・バックエンド・外部APIキーは一切不要です。AI推論はブラウザ内で完結し、データはすべてこの端末の IndexedDB / LocalStorage にのみ保存されます。

## 特徴

- **ログイン不要の匿名 Twitch IRC 接続**: `wss://irc-ws.chat.twitch.tv` に直接接続し、色付き表示名・emote 画像付きでチャットをリアルタイム表示します
- **Gemini Nano によるその場解説**: 発言をクリックすると、訳・直訳・注目語句(スラング/略語/イディオム/emote/文法/単語の種別・意味・使い方メモ)・難易度を JSON Schema で構造化して取得します
- **手動ピック + 自動抽出の併用**: 気になった発言は手動でカード化できるほか、設定で自動抽出を有効にすると学習価値の高い発言をバックグラウンドで拾い、`/deck` の候補レビューに貯めます
- **単語帳(`/deck`)**: 保存したカードの検索・削除・JSON エクスポート、自動抽出候補の採用/却下ができます
- **復習クイズ(`/study`)**: SM-2 相当のアルゴリズムで出題間隔を管理し、「意味当て4択」「穴埋め」の2形式で出題します。LLM に依存しないため、Prompt API が使えない環境でも復習だけは継続できます
- **言語ペア設定(`/settings`)**: 学ぶ言語(targetLang)と解説言語(explainLang)を en / ja / es / de / fr から選べます。同一言語の組み合わせは保存時にエラーになります
- **環境診断とデータ管理(`/settings`)**: Chrome バージョン・Prompt API / Language Detector API の可用性・ストレージ空き容量を診断して表示するほか、保存データ(IndexedDB + LocalStorage)を確認ダイアログ付きで一括削除できます

## アーキテクチャ

サーバーコードは一切持ちません。Next.js の App Router を使いますが、全ページをクライアントコンポーネントとして構成し、Route Handler・Server Action は作っていません。

```
チャンネル指定
   ↓
Twitch IRC (WebSocket, 匿名)  ──→ messages (Dexie, リングバッファ)
   ↓                                  ↓
ノイズ除去フィルタ(純関数)      ライブ表示(クリックで手動ピック)
   ↓                                  ↓
[低優先] 学習価値のboolean判定    [高優先] 解説生成
   ↓                                  ↓
        Gemini Nano 直列キュー(同時実行数1)
                    ↓
        構造化解説(responseConstraint / JSON Schema)
                    ↓
              cards (Dexie) ──→ 復習クイズ(SM-2)
```

Prompt API は Web Worker 非対応でメインスレッドでのみ動作するため、`src/lib/ai/session-pool.ts` が単一のベースセッション + 優先度付き直列キュー(手動ピック=高優先度、自動抽出=低優先度)でメインスレッドを保護します。ベースセッションは `session.clone()` で使い捨てブランチを都度作り、システムプロンプトのウォームアップを再利用しつつジョブ間のコンテキスト汚染を防ぎます。

### ディレクトリ構成

```
src/
  app/
    page.tsx              # ライブ画面(チャット + 解説ダイアログ)
    deck/page.tsx          # 単語帳(一覧・検索・削除・エクスポート・候補レビュー)
    study/page.tsx         # 復習クイズ
    settings/page.tsx      # 環境診断・言語設定・自動抽出設定・データ管理
  components/               # shadcn/ui ベースのUI
  lib/
    twitch/
      irc-parser.ts         # 純関数: IRC行 → 構造化メッセージ
      irc-client.ts          # WebSocket接続 / PING応答 / 再接続
      message-filter.ts      # 純関数: ノイズ除去・自動抽出の事前フィルタ
      emotes.ts               # 純関数: emotesタグ → CDN URL
    ai/
      availability.ts         # Prompt API / Language Detector APIの可用性診断
      session-pool.ts          # 単一セッション + 優先度付き直列キュー
      prompts.ts                # 言語ペアに応じたプロンプト生成
      schemas.ts                 # responseConstraint用JSON Schema
      explain.ts                  # 発言 → 構造化解説
      triage.ts                    # 発言 → 学習価値のboolean判定
      auto-extraction.ts            # message-filter → triage → explain のパイプライン
    db/
      schema.ts               # Dexieテーブル定義(messages/cards/reviews/candidates)
      cards.ts / messages.ts / candidates.ts / reviews.ts  # CRUD
      srs.ts                    # 純関数: SM-2間隔反復アルゴリズム
      reset.ts                    # データ全削除(IndexedDB)
    settings.ts               # LocalStorage設定の読み書き(zodバリデーション)
    study/quiz.ts              # 出題ロジック(4択・穴埋め)
```

## 必須要件(実行環境)

Prompt API(Gemini Nano)は Chrome にのみ組み込まれた実験的機能のため、以下を満たす環境が必要です。`/settings` の環境診断カードで自動判定されます。

| 項目 | 要件 |
|---|---|
| ブラウザ | Google Chrome 148 以降(Web ページ向けに stable 化済み。origin trialトークン不要) |
| 通信 | HTTPS または `localhost`(secure context)。ただし secure context は前提条件であり、これだけで利用可能になるわけではない |
| OS | デスクトップのみ(Windows / macOS / Linux、および Chromebook Plus)。Prompt API はモバイルChromeで未対応、通常のChromebookも対象外 |
| GPU | 4GB超のVRAM |
| ストレージ | 初回モデルダウンロードに空き 22GB 程度が必要 |
| ネットワーク | 初回モデルダウンロードは従量制回線では実行されない(unmetered connection) |
| 対応言語 | 入出力ともに `en` / `ja` / `es` / `de` / `fr` |

上記に加えてモデル自体のダウンロード完了とユーザー操作(アクティベーション)が必要なため、`/settings` の環境診断カードは secure context かどうかだけでなく、これらすべてを踏まえた最終的な利用可否を表示します。

**Prompt API が使えない環境でも、チャット閲覧・チャンネル接続・既存カードの復習(`/study`)は動作します。** AI解説・自動抽出のみが無効化され、`/settings` および解説ダイアログに理由が明示されます(クラウドAPIへの切り替えやダミー解説へのフォールバックは行いません)。

## セットアップ

```bash
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000) を Chrome 148 以降で開いてください(`localhost` は secure context として扱われるため Prompt API の利用条件の1つを満たします。ただし対応ハードウェア/OS・空きストレージ・モデルのダウンロード状況・ユーザー操作なども必要です)。初回はモデルダウンロードにユーザー操作を伴うボタン操作が必要です。

## 使い方

1. ホーム画面でTwitchのチャンネル名(例: `zackrawrr`)を入力して「接続する」を押す(ログイン不要の匿名接続)
2. 気になる発言をクリックすると、`/settings` で設定した言語ペアで解説ダイアログが開く
3. 解説内の語句にある「カード化」ボタンで単語帳に保存する
4. `/settings` で自動抽出を有効にすると、放置しているだけでも学習価値の高い発言が候補として貯まる(`/deck` でレビューして採用/却下)
5. `/study` で期日が来たカードだけが出題され、採点(Again/Hard/Good/Easy)に応じて次回の出題間隔が変わる

## データの保存場所と削除

chat-sensei 自身のサーバーは存在せず、アプリのデータ(受信したチャットの保存・AI解説の生成)はすべてこの端末内で完結します。ただし、指定したTwitchチャンネルへの接続に伴い、チャンネル名とチャット本文はTwitch側のサーバー(`wss://irc-ws.chat.twitch.tv`)へ送信されます(これはTwitch IRCへの接続方式上必須であり、匿名接続のためログインは不要です)。保存先は以下のブラウザ内ストレージのみです。

- **IndexedDB(Dexie)**: 受信したチャット(`messages`)・単語帳カード(`cards`)・復習履歴(`reviews`)・自動抽出候補(`candidates`)
- **LocalStorage**: 言語ペア・自動抽出のON/OFFと強度などの設定

`/settings` の「データ管理」カードから、確認ダイアログを経て上記すべてを一括削除できます。

## 開発コマンド

```bash
npm run dev         # 開発サーバー起動
npm run build        # 本番ビルド
npm run lint          # ESLint(警告ゼロを維持)
npm run type-check     # tsc --noEmit
npm test                # Vitest(単体テスト一括実行)
npm run test:watch       # Vitest(ウォッチモード)
```

テストは Vitest + React Testing Library + `fake-indexeddb` で構成し、`window.LanguageModel` / `WebSocket` / IndexedDB / 時刻などの外部依存はすべてモックしています。純関数(IRCパーサ・メッセージフィルタ・SM-2・プロンプト生成)を中心に TDD(RED→GREEN→REFACTOR)で実装しています。

## デプロイ

Vercel での静的配信のみを前提としています(サーバーサイド処理を持たないため、Vercel はビルド成果物の配信のみを担当します)。

```bash
vercel deploy          # プレビューデプロイ
vercel deploy --prod    # 本番デプロイ
```

Prompt API は secure context を要求するため、HTTPS で配信される Vercel のプレビュー/本番URLでは問題なく動作します。

## 使用技術

- [Next.js](https://nextjs.org/)(App Router / 全ページクライアントコンポーネント)
- [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)(Gemini Nano、構造化出力に `responseConstraint` を使用)
- [Dexie](https://dexie.org/)(IndexedDBラッパー)
- [Tailwind CSS](https://tailwindcss.com/) / [shadcn/ui](https://ui.shadcn.com/)
- [Zod](https://zod.dev/)(LocalStorage設定・AI応答のスキーマ検証)
- [Vitest](https://vitest.dev/) / [React Testing Library](https://testing-library.com/react) / [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB)
