/**
 * 自動 Pick up の決定的フィルタ(issue #95)で使う、英語の簡易レンマ化(ステミング)。
 *
 * `stemForMatch` は語形変化した語(making / quests / went)と基本形(make / quest / go)を
 * 同じ「照合キー」に揃えるための決定的な関数である。高頻度語リスト・表現リストの両側を
 * この同じ関数で正規化してから照合するため、返す文字列が言語学的に正しいレンマである必要はなく
 * (例: "make" → "mak")、両側でキーが一致することだけを保証すればよい。
 *
 * 対応する変化:
 * - 複数形・三単現の -s / -es / -ies
 * - 進行形の -ing、過去形の -ed(子音の重複「running → run」と語末 e の脱落「making → make」を含む)
 * - 頻出の不規則動詞・不規則名詞複数形・否定の短縮形(変化形 → 基本形の対応表)
 * - 所有・短縮の 's と主語+助動詞の短縮形('ll / 're / 've / 'd / 'm)
 *
 * 英語専用。他言語のリストが未整備の間はフィルタ自体を適用しないため(issue #95 の留意点)、
 * 多言語対応はリスト整備と合わせて拡張する。
 */

/** 語の前後に連続する、文字以外の記号(引用符・括弧・`!` など) */
const SURROUNDING_NON_LETTERS_PATTERN = /^[^\p{L}]+|[^\p{L}]+$/gu;

/** 同じ文字が2回以上連続する箇所(`ohhh` の `hhh` など) */
const REPEATED_LETTER_PATTERN = /(\p{L})\1+/gu;

/**
 * `ohhh` / `hmmm` のように文字を伸ばした形を照合できるよう、同じ文字の連続を1文字にまとめる。
 * `good` → `god` のように正当な重ね字も潰れるため、この結果だけで判定せず、
 * 必ず元の形と併用して照合すること(issue #97 の「どちらかが一致したら」方式)。
 * 笑い声・相槌の照合(pickup-filter.ts)で使う。
 */
export function collapseRepeatedLetters(word: string): string {
  return word.replace(REPEATED_LETTER_PATTERN, "$1");
}

/** 同じ文字が3回以上連続する箇所(`sooo` の `ooo` など) */
const ELONGATED_LETTER_PATTERN = /(\p{L})\1{2,}/gu;

/**
 * 同じ文字が3回以上連続する箇所だけを1文字にまとめる(`sooo` → `so` / `niceee` → `nice`)。
 * 高頻度語の照合(pickup-ordinary-filter.ts)で使う。2文字連続まで潰すと `loot` → `lot` /
 * `yeet` → `yet` / `weeb` → `web` のように正当なスラングが高頻度語と誤衝突するため、
 * 英語の正当な綴りにほぼ現れない3連続以上だけを伸ばし字とみなす(issue #97 のレビュー指摘)。
 * 正規表現の後方参照は大小文字を区別するため、混在ケース(`SOoo`)は呼び出し側で小文字化してから渡すこと。
 */
export function collapseElongatedLetters(word: string): string {
  return word.replace(ELONGATED_LETTER_PATTERN, "$1");
}

/**
 * 語句を照合用の語の配列に分割する。空白で区切り、各語の前後の記号を外す。
 * 語の内部のアポストロフィ・ハイフン("don't" / "uh-oh")は保持し、
 * 記号だけの語(全部外れて空になったもの)は除く。
 * データ生成スクリプト(scripts/generate-pickup-filter-data.mjs)と実行時フィルタ
 * (pickup-ordinary-filter.ts)の両方がこの同じ分割を使うことで、枝刈りと照合の基準を揃える。
 */
export function splitIntoMatchWords(term: string): string[] {
  return term
    .split(/\s+/)
    .map((word) => word.replace(SURROUNDING_NON_LETTERS_PATTERN, ""))
    .filter((word) => word !== "");
}

/**
 * 頻出の不規則な変化形 → 基本形の対応表。
 * 対応表を引いたあとも共通の接尾辞規則を通すため、値は自然な綴りの基本形で書く
 * (例: "made" → "make" と登録し、"make" 自体の照合キー("mak")と一致させる)。
 * 網羅は目的とせず、チャットで頻出する語に限定する。漏れた不規則形は基本形と別のキーになるが、
 * その語が高頻度語リストに無ければ「落とさず残す」方向に倒れるため安全側である。
 */
const IRREGULAR_FORMS: Record<string, string> = {
  // be 動詞・助動詞まわり
  was: "be", were: "be", is: "be", are: "be", am: "be", been: "be", being: "be",
  // 不規則動詞の過去形・過去分詞
  went: "go", gone: "go", did: "do", done: "do", said: "say", made: "make",
  got: "get", gotten: "get", took: "take", taken: "take", came: "come",
  saw: "see", seen: "see", knew: "know", known: "know", gave: "give", given: "give",
  told: "tell", thought: "think", bought: "buy", brought: "bring", caught: "catch",
  taught: "teach", felt: "feel", kept: "keep", left: "leave", met: "meet",
  ran: "run", sat: "sit", stood: "stand", spoke: "speak", spoken: "speak",
  broke: "break", broken: "break", wore: "wear", worn: "wear", won: "win",
  sent: "send", spent: "spend", built: "build", heard: "hear", held: "hold",
  lost: "lose", paid: "pay", found: "find", fell: "fall", fallen: "fall",
  flew: "fly", flown: "fly", drew: "draw", drawn: "draw", drove: "drive", driven: "drive",
  ate: "eat", eaten: "eat", wrote: "write", written: "write", chose: "choose", chosen: "choose",
  woke: "wake", woken: "wake", threw: "throw", thrown: "throw", sold: "sell",
  understood: "understand", began: "begin", begun: "begin", dying: "die",
  // 不規則名詞の複数形
  men: "man", women: "woman", children: "child", feet: "foot", teeth: "tooth", mice: "mouse",
  // 否定の短縮形
  "don't": "do", "doesn't": "do", "didn't": "do", "can't": "can", cannot: "can",
  "won't": "will", "wouldn't": "would", "shouldn't": "should", "couldn't": "could",
  "isn't": "be", "aren't": "be", "wasn't": "be", "weren't": "be", "ain't": "be",
};

/** 語末の連続する同じ子音を1つにまとめる際に、まとめない子音(fall / stuff / boss / buzz を保つ) */
const KEEP_DOUBLED_CONSONANTS = new Set(["l", "s", "z", "f"]);

/** -ing / -ed を外したあとの「runn → run」のような子音の重複を1つにまとめる */
function undoubleFinalConsonant(word: string): string {
  const last = word.at(-1);
  if (last === undefined || word.at(-2) !== last) return word;
  if (/[aeiou]/.test(last) || KEEP_DOUBLED_CONSONANTS.has(last)) return word;
  return word.slice(0, -1);
}

/**
 * 語を照合キーに正規化する。
 * 変化形と基本形が同じキーになるよう、両者に共通で適用できる決定的な規則を順に適用する。
 */
export function stemForMatch(word: string): string {
  let stem = word.toLowerCase();
  stem = IRREGULAR_FORMS[stem] ?? stem;
  if (stem.endsWith("'s")) stem = stem.slice(0, -2);
  // 主語+助動詞の短縮形("it'll" / "you're" / "they've" / "he'd" / "i'm")は助動詞側を外して
  // 主語側の語に揃える(issue #115 の観測: "almost it'll be" のようなリスト外のフラグメントが
  // "it'll" 1語のせいで高頻度判定に乗らず残るのを防ぐ)。否定の短縮形は上の対応表が先に処理する
  stem = stem.replace(/'(?:ll|re|ve|d|m)$/, "");

  // 複数形・三単現: -ies は基本形の「子音 + y」側も後段の規則で i に揃うため -i に置き換える
  if (stem.endsWith("ies") && stem.length > 4) {
    stem = stem.slice(0, -3) + "i";
  } else if (/(?:s|x|z|ch|sh)es$/.test(stem)) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith("s") && stem.length > 3 && !/(?:ss|us|is)$/.test(stem)) {
    stem = stem.slice(0, -1);
  }

  // 進行形 -ing(sing / bring のような短い基本形を壊さないよう6文字以上に限る)・過去形 -ed
  if (stem.endsWith("ing") && stem.length >= 6) {
    stem = undoubleFinalConsonant(stem.slice(0, -3));
  } else if (stem.endsWith("ed") && stem.length >= 4) {
    stem = undoubleFinalConsonant(stem.slice(0, -2));
  }

  // 語末の e を落とす(making → mak と make → mak を揃える)
  if (stem.endsWith("e") && stem.length > 2) {
    stem = stem.slice(0, -1);
  }
  // 「子音 + y」を i に揃える(tried → tri と try → tri を揃える)
  if (stem.endsWith("y") && stem.length > 2 && !/[aeiou]y$/.test(stem)) {
    stem = stem.slice(0, -1) + "i";
  }
  return stem;
}
