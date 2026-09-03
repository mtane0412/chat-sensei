/**
 * 自動 Pick up の決定的フィルタ(issue #95)が参照するデータファイルを生成するスクリプト。
 *
 * 以下の2ファイルを `src/lib/ai/data/` に出力する。いずれも生成結果をリポジトリに
 * コミットして同梱する(実行時にネットワークへは出ない)。
 *
 * 1. `en-expression-list.json`: 英語の学習表現リスト(複数語のみ)。
 *    Wiktionary の句動詞・イディオム・スラング系カテゴリの見出し語を MediaWiki API から取得する。
 *    見出し語リストは CC BY-SA 4.0(Wiktionary)。
 * 2. `en-frequent-words.json`: 英語の高頻度語リスト(約2800レンマ + 手動補完)。
 *    New General Service List (NGSL) 1.2 (Browne, C., Culligan, B., and Phillips, J.)。
 *    CC BY-SA 4.0。
 *
 * 表現リストは「全語が高頻度語で構成される表現」だけに枝刈りして出力する。
 * 実行時フィルタ(pickup-ordinary-filter.ts)は非高頻度語を含む語句を表現リストの照合前に
 * 「残す」と判定するため、非高頻度語を含む表現はリストに入れても参照されず、
 * 枝刈りしても挙動は変わらない(クライアントバンドルのサイズ削減が目的)。
 * 枝刈りの判定は実行時と同じ `stem.ts` の正規化・分割を import して使い、基準のずれを防ぐ。
 *
 * 実行方法: `node scripts/generate-pickup-filter-data.mjs`
 * 再生成すると取得時点のカテゴリ内容で上書きされる(Wiktionary は日々更新されるため差分が出る)。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Node.js の型ストリッピング(Node 22.6+)で実行時フィルタと同じ正規化・分割を直接 import する
import { splitIntoMatchWords, stemForMatch } from "../src/lib/ai/stem.ts";

const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "ai", "data");

const WIKTIONARY_API = "https://en.wiktionary.org/w/api.php";
/**
 * 取得対象のカテゴリ。句動詞・イディオムに加え、スラング系のカテゴリも結合する。
 * "no cap"(AAVE)や "touch grass"(internet slang)のような複数語スラングは
 * 「English idioms」カテゴリに入っていないため、スラング系カテゴリからも拾う必要がある。
 * 収録は複数語の見出し語だけなので、カテゴリ自体が大きくてもリストは肥大しない。
 */
const WIKTIONARY_CATEGORIES = [
  "Category:English phrasal verbs",
  "Category:English idioms",
  "Category:English slang",
  "Category:English internet slang",
  "Category:English informal terms",
  "Category:African-American Vernacular English",
  "Category:English Twitch-speak",
];
/** MediaWiki API の1リクエストあたりの最大取得件数 */
const PAGE_LIMIT = 500;

const NGSL_CSV_URL = "https://raw.githubusercontent.com/ThHanke/englishLessons/master/data/wordlists/ngsl-1.2.csv";

/**
 * NGSL に無いが、この用途では「普通の単語」として扱いたい語の手動補完リスト。
 * 配信チャットで頻出する字義通りの語のうち、学習者が容易に推測できるものに限る
 * (実例: "main quests" の "quest" は NGSL 圏外だが普通の単語。issue #95 のゴールデンセット)。
 * "raid" / "emote" / "sub" のような Twitch 特有の意味を持つ語は学習価値があるため入れない。
 * 表現リストの枝刈り基準にも使うため、変更したらこのスクリプトを再実行すること。
 */
const SUPPLEMENTARY_FREQUENT_WORDS = ["quest", "streamer", "gamer"];

/**
 * 表現リストに収録する見出し語かを判定する。
 * - 複数語(空白を含む)のみ収録する。1語の語句は高頻度語リスト側の判定で足りるため
 * - アルファベット・アポストロフィ・ハイフン・カンマ・空白だけで構成される見出し語に限る
 *   (「Appendix:〜」のような特殊ページや、記号・数字を含む見出し語を除く)
 * - 大文字を含む見出し語(固有名詞由来のイディオム等)は照合が小文字基準のため小文字化して収録する
 */
function isExpressionEntry(title) {
  if (!title.includes(" ")) return false;
  return /^[a-zA-Z',\- ]+$/.test(title);
}

/** 指定カテゴリの全見出し語(ns=0)を categorymembers API のページングで取得する */
async function fetchCategoryMembers(category) {
  const titles = [];
  let cmcontinue = undefined;
  do {
    const params = new URLSearchParams({
      action: "query",
      list: "categorymembers",
      cmtitle: category,
      cmnamespace: "0",
      cmlimit: String(PAGE_LIMIT),
      format: "json",
    });
    if (cmcontinue) params.set("cmcontinue", cmcontinue);
    const response = await fetch(`${WIKTIONARY_API}?${params}`, {
      headers: { "User-Agent": "chat-sensei data generator (https://github.com/mtane0412/chat-sensei)" },
    });
    if (!response.ok) {
      throw new Error(`Wiktionary API がエラーを返しました: ${response.status} (${category})`);
    }
    const json = await response.json();
    for (const member of json.query.categorymembers) {
      titles.push(member.title);
    }
    cmcontinue = json.continue?.cmcontinue;
  } while (cmcontinue);
  return titles;
}

/** NGSL 1.2 の CSV からレンマ列(1列目)を取り出す。ヘッダ行は除く */
async function fetchNgslLemmas() {
  const response = await fetch(NGSL_CSV_URL);
  if (!response.ok) {
    throw new Error(`NGSL CSV の取得に失敗しました: ${response.status}`);
  }
  const csv = await response.text();
  const lemmas = csv
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[0].trim().toLowerCase())
    .filter((lemma) => /^[a-z][a-z'-]*$/.test(lemma));
  return [...new Set(lemmas)];
}

async function main() {
  const [memberLists, ngslLemmas] = await Promise.all([
    Promise.all(WIKTIONARY_CATEGORIES.map(fetchCategoryMembers)),
    fetchNgslLemmas(),
  ]);

  const frequentStems = new Set([...ngslLemmas, ...SUPPLEMENTARY_FREQUENT_WORDS].map(stemForMatch));
  const allExpressions = [
    ...new Set(
      memberLists
        .flat()
        .filter(isExpressionEntry)
        .map((title) => title.toLowerCase()),
    ),
  ].sort();
  // 枝刈り: 全語が高頻度語で構成される表現だけを残す(冒頭コメントを参照)
  const expressions = allExpressions.filter((expression) =>
    splitIntoMatchWords(expression).every((word) => frequentStems.has(stemForMatch(word))),
  );

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUTPUT_DIR, "en-expression-list.json"),
    JSON.stringify(
      {
        source: `English Wiktionary categories (headword titles only): ${WIKTIONARY_CATEGORIES.map((category) => category.replace("Category:", "")).join(", ")}`,
        sourceUrl: "https://en.wiktionary.org/wiki/Category:English_phrasal_verbs",
        license: "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
        note: "Multi-word headwords only, pruned to expressions whose words are all in en-frequent-words.json (see scripts/generate-pickup-filter-data.mjs)",
        generatedAt: new Date().toISOString().slice(0, 10),
        expressions,
      },
      null,
      0,
    ),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "en-frequent-words.json"),
    JSON.stringify(
      {
        source: "New General Service List (NGSL) 1.2 by Browne, C., Culligan, B., and Phillips, J.",
        sourceUrl: "https://www.newgeneralservicelist.com/",
        license: "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
        generatedAt: new Date().toISOString().slice(0, 10),
        ngslWords: ngslLemmas,
        supplementaryWords: SUPPLEMENTARY_FREQUENT_WORDS,
      },
      null,
      0,
    ),
  );

  console.log(`en-expression-list.json: ${expressions.length} expressions (before pruning: ${allExpressions.length})`);
  console.log(`en-frequent-words.json: ${ngslLemmas.length} NGSL words + ${SUPPLEMENTARY_FREQUENT_WORDS.length} supplementary words`);
}

await main();
