/**
 * 自動 Pick up の決定的フィルタ(issue #95)が参照するデータファイルを生成するスクリプト。
 *
 * 以下の2ファイルを `src/lib/ai/data/` に出力する。いずれも生成結果をリポジトリに
 * コミットして同梱する(実行時にネットワークへは出ない)。
 *
 * 1. `en-expression-list.json`: 英語の学習表現リスト(複数語のみ)。
 *    Wiktionary の句動詞・イディオム・スラング系カテゴリの見出し語を MediaWiki API から取得する。
 *    見出し語リストは CC BY-SA 4.0(Wiktionary)。
 * 2. `en-frequent-words.json`: 英語の高頻度語リスト。以下の2層 + 手動補完で構成する。
 *    - 第1層: New General Service List (NGSL) 1.2 (Browne, C., Culligan, B., and Phillips, J.)
 *      約2800レンマ。CC BY-SA 4.0。
 *    - 第2層(issue #99): OpenSubtitles 2018 由来の字幕頻度リスト(hermitdave/FrequencyWords)の
 *      上位語から、NGSL と重複する語・スラング・Twitch特有の意味を持つ語を除いたもの。CC BY-SA 4.0。
 *      "flavour" / "paradise" / "pimple" のような NGSL 圏外の普通語を1語判定で落とすための補完。
 *      頻度リスト上位に混ざるスラング("lol" / "shit" など)を落とさないよう、
 *      Wiktionary の狭義スラングカテゴリの1語見出し語を「頻度リストから除外する側」に使う。
 *
 * 表現リストは複数語の見出し語をすべて収録する(枝刈りしない)。issue #106 までは実行時フィルタの
 * 救済判定にしか使わなかったため「全語が高頻度語 or 語数上限超」の表現に枝刈りしていたが、
 * 候補生成(issue #115。本文がリストに合致したら自動 Pick up する経路)では非高頻度語を含む
 * 語数上限内のイディオムにもマッチさせる必要があるため、枝刈りを撤廃した(#112 コメントの決定事項 2)。
 *
 * 実行方法: `node scripts/generate-pickup-filter-data.mjs`
 * 再生成すると取得時点のカテゴリ内容で上書きされる(Wiktionary は日々更新されるため差分が出る)。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Node.js の型ストリッピング(Node 22.6+)で実行時フィルタと同じ正規化を直接 import する
import { stemForMatch } from "../src/lib/ai/stem.ts";

const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "ai", "data");

const WIKTIONARY_API = "https://en.wiktionary.org/w/api.php";
/**
 * 表現リストの取得対象のカテゴリ。句動詞・イディオムに加え、スラング系のカテゴリも結合する。
 * "no cap"(AAVE)や "touch grass"(internet slang)のような複数語スラングは
 * 「English idioms」カテゴリに入っていないため、スラング系カテゴリからも拾う必要がある。
 * 卑語のカテゴリ(swear words)は issue #99 の除外リスト用に取得するため、複数語の卑語表現も
 * 表現リストに結合する。収録は複数語の見出し語だけなので、カテゴリ自体が大きくてもリストは肥大しない。
 *
 * 接続詞・前置詞句のカテゴリ(issue #115)は "even though" / "at least" / "in spite of" のような
 * 教科書的な定型接続表現・前置詞句をカバーする。これらはイディオム・スラング系カテゴリの
 * いずれにも入っておらず、従来は pickup-ordinary-filter.ts の CURATED_EXPRESSIONS で
 * 1件ずつ手動補完していた(#112 コメントの決定事項 2)。
 */
const EXPRESSION_CATEGORIES = [
  "Category:English phrasal verbs",
  "Category:English idioms",
  "Category:English slang",
  "Category:English internet slang",
  "Category:English informal terms",
  "Category:African-American Vernacular English",
  "Category:English Twitch-speak",
  "Category:English swear words",
  "Category:English conjunctions",
  "Category:English prepositional phrases",
];
/**
 * 字幕頻度リスト(第2層)から除外する1語見出し語を取るカテゴリ(issue #99)。
 * 字幕由来の頻度リストは "lol"(18339位)や "shit"(285位)のようなスラング・卑語が上位に混ざるため、
 * そのまま高頻度語扱いにすると学習価値のある語を落としてしまう。
 *
 * `EXPRESSION_CATEGORIES` のサブセットである点に注意。広義の「English slang」「English informal terms」は
 * 主要語義が普通語で俗語の語義を1つ持つだけの語(実例: "paradise" / "pimple" は English slang に収録)を
 * 大量に含み、除外に使うと issue #99 のゴールデンセットそのものを取りこぼす。そのため、
 * カテゴリ収録が「スラングとしての語」をほぼ意味する狭義のカテゴリだけを除外に使う。
 * この設計の帰結として、広義カテゴリにしか入らない超高頻度の口語("dude" 708位 / "damn" 396位)は
 * 普通の語として落ちる(頻度からみて学習者が繰り返し目にする語であり、Pick up に出す価値は低い)。
 */
const EXCLUSION_CATEGORIES = [
  "Category:English internet slang",
  "Category:African-American Vernacular English",
  "Category:English Twitch-speak",
  "Category:English swear words",
];
/** MediaWiki API の1リクエストあたりの最大取得件数 */
const PAGE_LIMIT = 500;

const NGSL_CSV_URL = "https://raw.githubusercontent.com/ThHanke/englishLessons/master/data/wordlists/ngsl-1.2.csv";

/**
 * 字幕頻度リスト(第2層)のソース。OpenSubtitles 2018 の字幕コーパスから作られた
 * 頻度順の語リスト(hermitdave/FrequencyWords、CC BY-SA 4.0)。
 * 話し言葉のコーパスのため、配信チャットの語彙分布に Web コーパスより近い。
 * 2018年版のスナップショットを参照するため、再生成しても内容は安定している。
 */
const SUBTITLE_FREQUENCY_URL =
  "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt";
/**
 * 字幕頻度リストから採用する上位語数。実チャットで観測した NGSL 圏外の普通語
 * (issue #99: "paradise" 3367位 / "flavour" 13415位 / "pimple" 21949位)をすべて含み、
 * かつこれより深い帯域で増える固有名詞・ノイズを避ける値として選んだ。
 */
const SUBTITLE_TOP_N = 25000;

/**
 * 字幕頻度リストの上位に入るが、Twitch・ゲーム配信の文脈で特有の意味を持つため
 * 高頻度語(=普通の単語)として扱わない語の手動除外リスト(issue #99)。
 * 例: "raid"(字幕4835位)は「他配信者への送客」、"sub" は「サブスクライバー」、
 * "clip" は「切り抜き」、"lurk" は「発言せず視聴」、"troll" は「荒らし」、"loot" は「戦利品」の
 * 意味で使われ、学習価値がある。
 * `EXCLUSION_CATEGORIES` に未収載でも確実に残すための保険であり、
 * NGSL 本体に入っている語(第1層)はこのリストでは復活しない点に注意。
 */
const TWITCH_MEANING_WORDS = ["raid", "sub", "clip", "lurk", "emote", "troll", "loot"];

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
  // カテゴリ名の変更・打ち間違いに気づけるよう、空のカテゴリは Fail-Fast でエラーにする
  if (titles.length === 0) {
    throw new Error(`Wiktionary カテゴリが空です(カテゴリ名を確認してください): ${category}`);
  }
  return titles;
}

/**
 * スラング系カテゴリの1語見出し語かを判定する(字幕頻度リストからの除外用)。
 * 頻度リスト側が小文字のアルファベット・アポストロフィ・ハイフンの語だけを持つため、
 * それに一致しうる1語の見出し語だけを除外対象にする。
 */
function isSingleWordEntry(title) {
  return !title.includes(" ") && /^[a-zA-Z'-]+$/.test(title);
}

/**
 * 字幕頻度リストの上位 `SUBTITLE_TOP_N` 語を取得する。
 * ファイルは「語 出現回数」の頻度降順の行形式。順位はフィルタ前の行位置で数える。
 */
async function fetchSubtitleTopWords() {
  const response = await fetch(SUBTITLE_FREQUENCY_URL);
  if (!response.ok) {
    throw new Error(`字幕頻度リストの取得に失敗しました: ${response.status}`);
  }
  const text = await response.text();
  return text
    .split("\n")
    .slice(0, SUBTITLE_TOP_N)
    .map((line) => line.split(" ")[0].trim())
    .filter((word) => /^[a-z][a-z'-]*$/.test(word));
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
  const [memberLists, ngslLemmas, subtitleTopWords] = await Promise.all([
    Promise.all(EXPRESSION_CATEGORIES.map(fetchCategoryMembers)),
    fetchNgslLemmas(),
    fetchSubtitleTopWords(),
  ]);
  // 除外用カテゴリは表現用カテゴリのサブセットのため、取得済みの結果を引き直して二重取得を避ける
  const membersByCategory = new Map(EXPRESSION_CATEGORIES.map((category, index) => [category, memberLists[index]]));
  const exclusionTitles = EXCLUSION_CATEGORIES.flatMap((category) => membersByCategory.get(category));

  // 第2層(issue #99): 字幕頻度リストの上位語から、第1層(NGSL + 手動補完)と重複する語、
  // 狭義スラングカテゴリの1語見出し語、Twitch特有の意味を持つ語を除いたもの。
  // 照合キー(ステム)単位で重複を除き、同じキーの変化形は頻度が高い方の1語だけを収録する
  const firstLayerStems = new Set([...ngslLemmas, ...SUPPLEMENTARY_FREQUENT_WORDS].map(stemForMatch));
  const excludedStems = new Set(
    [...exclusionTitles.filter(isSingleWordEntry).map((title) => title.toLowerCase()), ...TWITCH_MEANING_WORDS].map(
      stemForMatch,
    ),
  );
  /**
   * 字幕頻度リストの語が除外対象かを判定する。字幕コーパスには "fuckin" のような
   * g落ちの口語形が含まれるため、"g" を補った形("fucking" → ステム "fuck")でも照合する。
   * g復元の照合は除外判定だけに使う点に注意: "somethin" / "gettin" のような普通語のg落ち形は
   * 第2層に収録してこそ実行時に落とせる(g復元で第1層と重複扱いにすると取りこぼす)。
   */
  const isExcludedSubtitleWord = (word) =>
    excludedStems.has(stemForMatch(word)) || (word.endsWith("in") && excludedStems.has(stemForMatch(`${word}g`)));

  const subtitleWords = [];
  const subtitleStems = new Set();
  for (const word of subtitleTopWords) {
    const stem = stemForMatch(word);
    if (firstLayerStems.has(stem) || subtitleStems.has(stem) || isExcludedSubtitleWord(word)) continue;
    subtitleStems.add(stem);
    subtitleWords.push(word);
  }

  // 複数語の見出し語をすべて収録する(枝刈りしない。冒頭コメントを参照)
  const expressions = [
    ...new Set(
      memberLists
        .flat()
        .filter(isExpressionEntry)
        .map((title) => title.toLowerCase()),
    ),
  ].sort();

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUTPUT_DIR, "en-expression-list.json"),
    JSON.stringify(
      {
        source: `English Wiktionary categories (headword titles only): ${EXPRESSION_CATEGORIES.map((category) => category.replace("Category:", "")).join(", ")}`,
        sourceUrl: "https://en.wiktionary.org/wiki/Category:English_phrasal_verbs",
        license: "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
        note: "Multi-word headwords only, unpruned (see scripts/generate-pickup-filter-data.mjs)",
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
        subtitleSource:
          "FrequencyWords (hermitdave), en_50k 2018, derived from the OpenSubtitles 2018 corpus; pruned to stems not covered by NGSL, excluding Wiktionary slang-category single words and Twitch-meaning words (see scripts/generate-pickup-filter-data.mjs)",
        subtitleSourceUrl: "https://github.com/hermitdave/FrequencyWords",
        subtitleLicense: "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
        generatedAt: new Date().toISOString().slice(0, 10),
        ngslWords: ngslLemmas,
        supplementaryWords: SUPPLEMENTARY_FREQUENT_WORDS,
        subtitleWords,
      },
      null,
      0,
    ),
  );

  console.log(`en-expression-list.json: ${expressions.length} expressions`);
  console.log(
    `en-frequent-words.json: ${ngslLemmas.length} NGSL words + ${SUPPLEMENTARY_FREQUENT_WORDS.length} supplementary words + ${subtitleWords.length} subtitle words`,
  );
}

await main();
