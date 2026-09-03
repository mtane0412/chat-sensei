/**
 * Pick up(注目の表現の抽出)の前後に置く、LLM を使わない決定的な処理(issue #26)。
 *
 * Gemini Nano はプロンプトで「emote 名・数字・@メンションは含めない」と指示しても
 * それらを「特殊な表現」として返すことがある。emote の位置は Twitch IRC の `emotes` タグで
 * 確定しているため、LLM に判断させず同じ入力なら必ず同じ結果になる処理で扱う。
 *
 * - `preparePickupInput`: 送信前の足切り。emote・@メンション・URL を本文から除き、
 *   LLM に渡す本文と、後段フィルタで照合するための emote 名・メンション名を返す
 * - `filterPickupTerms`: 後段フィルタ。返ってきた語句のうち emote 名・@メンション・
 *   `!` で始まるチャットコマンド・文字を1つも含まない語句(数字や記号だけ)・
 *   `haha` のような笑い声(issue #30)・`www` のような日本語型の笑い声(issue #97)・
 *   `oh` / `wow` / `hmm` のような相槌・感嘆詞(issue #33)・
 *   呼び出し側が指定した除外名(表示中の発言者名など)を落とし、重複する語句は1件にまとめる
 * - `filterTranslationArtifactTerms`: 逆方向 Pick up(機械翻訳の訳文からの抽出)専用の後段フィルタ。
 *   訳文の誤訳・幻覚に由来しやすい固有名詞的な語句を落とす
 * - `filterForeignScriptMeaningTerms`: 意味テキストに解説言語で使わない文字種(キリル文字など)が
 *   混ざった語句を落とす(issue #98)
 * - `filterProperNounPhraseTerms`: 順方向 Pick up 用の後段フィルタ。文中(先頭以外)に固有名詞的な語を
 *   含む語句を落とす(issue #100)
 * - `filterQuestionSentenceTerms`: 末尾が疑問符の複数語の語句(疑問文まるごとの抽出)を落とす(issue #100)
 * - `filterLongPhraseTerms`: 語数が上限(6語)を超え、かつ表現リストに無い語句(文まるごとの抽出)を
 *   落とす(issue #104)
 *
 * 翻訳列は「emote 名はそのまま残す」設計のため、この処理は Pick up 専用である。
 */
import { splitMessageIntoSegments } from "@/lib/twitch/emotes";
import type { EmotePosition } from "@/lib/twitch/irc-parser";
import { isListedExpression } from "./pickup-ordinary-filter";
import { MAX_PICKUP_TERM_WORD_COUNT } from "./pickup-term-limits";
import type { SupportedLanguage } from "./prompts";
import type { PickupTerm } from "./schemas";
import { collapseRepeatedLetters, splitIntoMatchWords } from "./stem";

/** `preparePickupInput` の結果。LLM に渡す本文と、後段フィルタの照合に使う情報 */
export interface PreparedPickupInput {
  /** LLM に渡す本文。emote・@メンション・URL を除き、連続する空白を1つにまとめた文字列 */
  text: string;
  /** 本文から除いた emote 名(重複なし) */
  emoteNames: string[];
  /** 本文から除いた @メンションのユーザー名(@ を外したもの、重複なし) */
  mentionNames: string[];
}

/** `@username` 形式のメンション。Twitch のユーザー名は英数字とアンダースコアのみ */
const MENTION_PATTERN = /@(\w+)/g;
/** http(s) で始まる URL。空白までを1つの URL とみなす */
const URL_PATTERN = /https?:\/\/\S+/g;
/** 文字(どの言語の文字でもよい)を1つも含まない語句にマッチする */
const NO_LETTER_PATTERN = /^[^\p{L}]*$/u;
/**
 * `haha` / `hahaha` / `hehe` / `hah` のような笑い声にマッチする(issue #30)。
 * 笑い声は学ぶべき表現ではないが、`lol` / `lmao` は略語として学ぶ価値があるためここでは扱わない。
 * `haha!` / `(hehe)` のように前後に記号が付く形は、`SURROUNDING_NON_LETTERS_PATTERN` で記号を外してから照合する。
 */
const LAUGHTER_PATTERN = /^(ha|he)+h?$/i;
/**
 * `www` / `wwww` / 全角の `ｗｗｗ` のような日本語圏由来の笑い声にマッチする(issue #97)。
 * 単独の `W` は「勝ち」を意味するスラング(learnable)のため2文字以上に限る。
 * `collapseRepeatedLetters` を通すと `www` が `w` に潰れて単独の `W` と区別できなくなるため、
 * この照合だけは潰す前の形(記号除去のみ)に対して行う。
 * 全角(`ｗ` U+FF57)は `i` フラグの simple case folding では半角に揃わないため文字クラスに明示する。
 */
const JAPANESE_LAUGHTER_PATTERN = /^[wｗ]{2,}$/i;
/** 語句の先頭・末尾に連続する、文字以外の記号(`!` `(` `)` `...` など) */
const SURROUNDING_NON_LETTERS_PATTERN = /^[^\p{L}]+|[^\p{L}]+$/gu;
/**
 * 言語を問わず普遍的に相槌・感嘆詞と判断できる語の除外辞書(issue #33)。
 * プロンプトで「相槌・感嘆詞は特殊な表現ではない」と指示しても Gemini Nano は `oh → 驚きを表す感嘆詞` のように返すため、
 * 笑い声(`LAUGHTER_PATTERN`)と同じ層で決定的に落とす。
 *
 * - 単独で意味を持たず、学習者が辞書を引く価値が無い語に限定する。`lol` / `pog` のような略語・ミームは入れない
 * - `om` は「oh my」「oh man」の短縮形で驚き・感嘆を表す相槌として使われるため入れる
 * - 語は自然な綴りで書き、照合と同じ `collapseRepeatedLetters` を通して登録する(`hmm` → `hm`、`aww` → `aw`)
 * - 英語の相槌のみを収録している。対象言語(`prompts.ts` の `SupportedLanguage`)固有の相槌は未対応で、
 *   必要になったら `targetLang` ごとの辞書に拡張する
 */
const INTERJECTIONS = new Set(
  ["oh", "ah", "eh", "uh", "um", "om", "hmm", "mhm", "wow", "whoa", "woah", "ugh", "huh", "aww", "ew", "yay"].map(
    collapseRepeatedLetters,
  ),
);

/**
 * チャット本文から Pick up の対象にならないトークンを除き、LLM に渡す本文を組み立てる。
 * emote だけの発言では `text` が空文字列になる(呼び出し側は LLM を呼ばずに済ませられる)。
 */
export function preparePickupInput(text: string, emotes: EmotePosition[]): PreparedPickupInput {
  const emoteNames = new Set<string>();
  const textWithoutEmotes = splitMessageIntoSegments(text, emotes)
    .map((segment) => {
      if (segment.type === "emote") {
        emoteNames.add(segment.text);
        // 前後の語が連結しないよう、emote の位置は空白に置き換える
        return " ";
      }
      return segment.text;
    })
    .join("");

  const mentionNames = new Set<string>();
  const stripped = textWithoutEmotes
    .replace(MENTION_PATTERN, (_match, name: string) => {
      mentionNames.add(name);
      return " ";
    })
    .replace(URL_PATTERN, " ");

  return {
    text: stripped.replace(/\s+/g, " ").trim(),
    emoteNames: [...emoteNames],
    mentionNames: [...mentionNames],
  };
}

/**
 * LLM が返した語句から、決定的に「注目の表現ではない」と判別できるものを落とす。
 * 照合は大文字小文字を区別しない(`pickup.ts` の原文照合と同じ基準)。
 *
 * @param extraExcludedNames 呼び出し側が追加で除外したい名前(表示中の発言者名など)
 */
export function filterPickupTerms(
  terms: PickupTerm[],
  prepared: PreparedPickupInput,
  extraExcludedNames: string[] = [],
): PickupTerm[] {
  const excludedNames = new Set(
    [...prepared.emoteNames, ...prepared.mentionNames, ...extraExcludedNames].map((name) => name.toLowerCase()),
  );
  /** 既に残した語句(小文字化済み)。同じ語句が繰り返し返ってきても最初の1件だけ残す */
  const seen = new Set<string>();
  return terms.filter((item) => {
    const normalized = item.term.trim().toLowerCase();
    // @メンションと、`!chimkin` のようなチャットコマンドは学ぶべき表現ではない
    if (normalized.startsWith("@") || normalized.startsWith("!")) return false;
    if (excludedNames.has(normalized)) return false;
    if (NO_LETTER_PATTERN.test(normalized)) return false;
    // 笑い声・相槌は `haha!` / `ohhh` のように記号や伸ばしが付いても同じ語なので、揃えてから照合する
    const stripped = normalized.replace(SURROUNDING_NON_LETTERS_PATTERN, "");
    const collapsed = collapseRepeatedLetters(stripped);
    if (LAUGHTER_PATTERN.test(collapsed) || INTERJECTIONS.has(collapsed)) return false;
    // 日本語型の笑い声(www)は潰すと単独の W(勝ちのスラング)と区別できないため、潰す前の形で照合する
    if (JAPANESE_LAUGHTER_PATTERN.test(stripped)) return false;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/** 大文字(どの言語の大文字でもよい) */
const UPPERCASE_LETTER_PATTERN = /\p{Lu}/u;
/** 小文字(どの言語の小文字でもよい) */
const LOWERCASE_LETTER_PATTERN = /\p{Ll}/u;
/** 大文字で始まりハイフンを含む単語(`Conto-me` / `Twitch-san` のような音写・敬称の残骸) */
const CAPITALIZED_HYPHENATED_WORD_PATTERN = /^\p{Lu}\S*-/u;

/**
 * 逆方向 Pick up(解説言語の発言を学ぶ言語へ機械翻訳した訳文からの抽出。issue #68)専用の後段フィルタ。
 *
 * 訳文は Gemini Nano が生成した機械翻訳であり、原文の固有名詞・挨拶・あだ名を誤訳・音写した
 * 実在しない「表現」が混ざる(実例: 「エオルゼア」→ "EoR"、「こんとめー」→ "Conto-me")。
 * 原文照合(`pickup.ts`)は訳文自体が壊れていると通過してしまうため、固有名詞的な形の語句を
 * 決定的に落とす。順方向(実際のチャット本文からの抽出)には適用しないこと。
 *
 * 落とす条件(いずれかに該当):
 * - 2文字目以降に大文字を含み、かつ小文字も含む語句("EoR" / "juggling with Tataru")。
 *   文頭に置かれただけの表現("Toss it!")や全大文字の略語("LOL")は該当しない
 * - 大文字で始まりハイフンを含む単語を含む語句("Conto-me" / "Twitch-san")。
 *   小文字のハイフン語("uh-oh")は該当しない
 *
 * 学ぶ言語がドイツ語の場合は名詞が常に大文字で書かれ、正当な表現まで落としてしまうため何も落とさない。
 *
 * 既知のトレードオフ: 綴りの形だけで判定するため、実在する混在ケースの語("iPhone" / "eBay")や
 * 大文字始まりの複合語("T-shirt" / "X-ray")も落ちる。ブランド名は固有名詞として Pick up の対象外に
 * したい語であり、普通の複合語は学習表現としての抽出対象になりにくいため、機械翻訳の幻覚を
 * 学習者に見せないこと(精度)を優先して許容する。issue #95 で導入した表現リスト
 * (`pickup-ordinary-filter.ts`。Wiktionary の句動詞・イディオム・スラング)による救済も検討したが、
 * リストは複数語の表現だけを収録しており "iPhone" / "T-shirt" のような1語の混在語を含まないため
 * 救済できず、見送った。救済が必要になったら混在語の許可リストを別途用意する。
 */
export function filterTranslationArtifactTerms(terms: PickupTerm[], learningLang: SupportedLanguage): PickupTerm[] {
  if (learningLang === "de") return terms;
  return terms.filter((item) => {
    const trimmed = item.term.trim();
    if (UPPERCASE_LETTER_PATTERN.test(trimmed.slice(1)) && LOWERCASE_LETTER_PATTERN.test(trimmed)) return false;
    if (trimmed.split(/\s+/).some(hasCapitalizedHyphenatedForm)) return false;
    return true;
  });
}

/** 単語の前後の記号(括弧・引用符など)を外したうえで、大文字始まりのハイフン語かを判定する */
function hasCapitalizedHyphenatedForm(word: string): boolean {
  return CAPITALIZED_HYPHENATED_WORD_PATTERN.test(word.replace(SURROUNDING_NON_LETTERS_PATTERN, ""));
}

/** 一人称の I とその短縮形(I'm / I'll / I've / I'd。曲がった引用符も許容する) */
const FIRST_PERSON_I_PATTERN = /^I['’]/;

/**
 * 順方向 Pick up(実際のチャット本文からの抽出)用の後段フィルタ(issue #100)。
 *
 * 固有名詞(ブランド名・人名など)は高頻度語リストに無いため、「非高頻度語を含む複数語句」として
 * ハイブリッドフィルタ(issue #95 の `filterOrdinaryTerms`)を通過してしまう(実例: ブランド名を含む
 * 疑問文がまるごと抽出された)。固有名詞は Pick up の対象外にしたい語のため、綴りの形で決定的に落とす。
 * 逆方向 Pick up には、より厳しい語句全体での判定(`filterTranslationArtifactTerms`。issue #94)が
 * 既に適用されるため、このフィルタは順方向専用である。
 *
 * 落とす条件: 文中(先頭以外)の語に「大文字と小文字の両方を含む語」がある語句。
 * 大文字始まりの固有名詞("Nike")に加え、語中に大文字を持つブランド名("iPhone" / "eBay")も
 * 該当する(#94 と同じ基準)。ただし表現リスト(issue #95)に一致する語句は正当な定型表現と
 * みなして残す。
 * - 先頭の語は文頭に置かれただけの表現("Toss it!")と区別できないため対象にしない
 * - 全大文字の語("LOL" / "big W" の "W")は略語・強調であり固有名詞とみなさない
 * - 一人称の "I" 単独は小文字を含まず対象外。"I'm" のような短縮形は明示的に除外する
 *
 * 学ぶ言語がドイツ語の場合は名詞が常に大文字で書かれ、正当な表現まで落としてしまうため何も落とさない
 * (issue #94 と同じ扱い)。
 *
 * 既知のトレードオフ: 先頭の1語だけの固有名詞("Snickers")は文頭と区別できず残る。また
 * チャット全体がタイトルケースで書かれた場合、表現リスト外の正当な表現も落ちる(固有名詞を
 * 学習者に見せないこと(精度)を優先して許容する)。
 */
export function filterProperNounPhraseTerms(terms: PickupTerm[], learningLang: SupportedLanguage): PickupTerm[] {
  if (learningLang === "de") return terms;
  return terms.filter((item) => {
    const words = splitIntoMatchWords(item.term);
    const hasProperNounLikeWord = words
      .slice(1)
      .some(
        (word) =>
          UPPERCASE_LETTER_PATTERN.test(word) &&
          LOWERCASE_LETTER_PATTERN.test(word) &&
          !FIRST_PERSON_I_PATTERN.test(word),
      );
    if (!hasProperNounLikeWord) return true;
    return isListedExpression(item.term);
  });
}

/**
 * 半角・全角の疑問符で終わる語句にマッチする(全角は機械翻訳の訳文に残ることがある)。
 * "are you serious?!" のように疑問符の後に感嘆符が続く形も疑問文の終わりとみなす。
 */
const TRAILING_QUESTION_MARK_PATTERN = /[?？]+[!！]*$/;

/**
 * 疑問文がまるごと1つの「表現」として抽出されたと判別できる語句を落とす後段フィルタ(issue #100)。
 *
 * Gemini Nano は発言ほぼ全体(疑問文など)を1つの表現として返すことがある。文まるごとの抽出は
 * 学ぶべき「特殊な表現」ではないため、末尾が疑問符の複数語の語句を落とす。
 * ただし表現リスト(issue #95)に一致する語句("what's up?" など)は疑問形の定型表現とみなして残す。
 * 1語の語句("Pardon?")は単語の聞き返しとして学習価値があるため対象にしない。
 *
 * 既知のトレードオフ:
 * - 表現リストは語数上限(issue #104)以下では全語が高頻度語の表現に枝刈りされているため、
 *   語数上限以下で非高頻度語を含む疑問形の定型表現は救済できず落ちる
 *   (文まるごとの抽出を学習者に見せないこと(精度)を優先して許容する)
 * - 語の分割は空白基準のため、空白を使わない言語(日本語)の疑問文は1語扱いになり落とせない
 */
export function filterQuestionSentenceTerms(terms: PickupTerm[]): PickupTerm[] {
  return terms.filter((item) => {
    const trimmed = item.term.trim();
    if (!TRAILING_QUESTION_MARK_PATTERN.test(trimmed)) return true;
    if (splitIntoMatchWords(trimmed).length < 2) return true;
    return isListedExpression(trimmed);
  });
}

/**
 * 語数が上限(`MAX_PICKUP_TERM_WORD_COUNT`)を超える語句(文まるごとの抽出)を落とす後段フィルタ(issue #104)。
 *
 * Gemini Nano は疑問文以外でも発言ほぼ全体を1つの「表現」として返すことがある。固有名詞も疑問符も
 * 含まない長い平叙文は既存のフィルタ(`filterProperNounPhraseTerms` / `filterQuestionSentenceTerms`)を
 * 通過してしまうため、語数で決定的に落とす。
 * ただし表現リスト(issue #95)に一致する語句("make a mountain out of a molehill" など)は
 * 長い定型表現とみなして残す。この救済を成立させるため、表現リストの枝刈り
 * (`scripts/generate-pickup-filter-data.mjs`)は語数が上限超の表現を非高頻度語を含んでいても
 * 無条件で収録するよう変更している(issue #104)。
 *
 * 既知のトレードオフ:
 * - 表現リストは英語のみのため、他言語の長い定型表現は救済できず落ちる
 *   (文まるごとの抽出を学習者に見せないこと(精度)を優先して許容する)
 * - 語の分割は空白基準のため、空白を使わない言語(日本語)の長文は1語扱いになり落とせない
 *   (`filterQuestionSentenceTerms` と同じ制約)
 */
export function filterLongPhraseTerms(terms: PickupTerm[]): PickupTerm[] {
  return terms.filter((item) => {
    if (splitIntoMatchWords(item.term).length <= MAX_PICKUP_TERM_WORD_COUNT) return true;
    return isListedExpression(item.term);
  });
}

/**
 * ラテン文字圏の意味テキストで許容しない文字にマッチする。
 * 「文字(`\p{L}`)であり、かつ Script_Extensions がラテン文字でも Common(々 などの共用文字)でも
 * Inherited(結合文字)でもない」文字を探す。数字・記号・絵文字は文字ではないため対象にならない。
 * Script ではなく Script_Extensions(scx)で判定するのは、複数スクリプトで共用される文字
 * (伸ばし棒 ー など)を取りこぼさないため。
 */
const NON_LATIN_LETTER_PATTERN = /(?=\p{L})[^\p{scx=Latin}\p{scx=Common}\p{scx=Inherited}]/u;
/** 日本語を含む意味テキストで許容しない文字にマッチする。上記にひらがな・カタカナ・漢字を加えた許容集合 */
const NON_JAPANESE_OR_LATIN_LETTER_PATTERN =
  /(?=\p{L})[^\p{scx=Latin}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}\p{scx=Common}\p{scx=Inherited}]/u;

/**
 * 意味テキストに解説言語で使わない文字種が混ざった語句を落とす後段フィルタ(issue #98)。
 *
 * Gemini Nano が生成した意味テキストには、解説言語で使わないスクリプトの単語が混入することがある
 * (実例: 解説言語が日本語の意味テキストにキリル文字の単語が混入する)。語句(term)側は原文照合
 * (`pickup.ts`)で正当性を担保できるが、意味(meaning)側には照合対象が無いため、文字種で
 * 決定的に検証する。壊れた意味を学習者に見せないことを優先し、再試行はせず落とすだけにする。
 *
 * 許容する文字種:
 * - ラテン文字はどの解説言語でも許容する(原文の語句や "laughing out loud" のような展開を
 *   意味に含めるため)
 * - 日本語の文字(ひらがな・カタカナ・漢字)は、解説言語か学ぶ言語のどちらかが日本語の場合に許容する。
 *   解説言語がラテン文字圏でも、意味テキストが原文の日本語の語句を引用するのは正当な出力のため
 * - 数字・記号・絵文字は文字ではないため常に許容する(emote 名はラテン文字なので同様に通る)
 *
 * 対応言語(`SupportedLanguage`)は en/ja/es/de/fr の5つで、日本語以外はすべてラテン文字圏のため、
 * 許容集合は「ラテン文字のみ」か「ラテン文字 + 日本語」の2通りで足りる。
 */
export function filterForeignScriptMeaningTerms(
  terms: PickupTerm[],
  explainLang: SupportedLanguage,
  learningLang: SupportedLanguage,
): PickupTerm[] {
  const foreignLetterPattern =
    explainLang === "ja" || learningLang === "ja" ? NON_JAPANESE_OR_LATIN_LETTER_PATTERN : NON_LATIN_LETTER_PATTERN;
  return terms.filter((item) => !foreignLetterPattern.test(item.meaning));
}
