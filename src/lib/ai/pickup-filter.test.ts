/**
 * src/lib/ai/pickup-filter.ts のテスト。
 *
 * Pick up の前後に置く決定的(LLM を使わない)処理を検証する(issue #26)。
 * - `preparePickupInput`: emote・@メンション・URL を本文から除き、LLM に渡す本文を組み立てる
 * - `filterPickupTerms`: LLM が返した語句のうち emote 名・@メンション・文字を含まない語句・笑い声(issue #30)・
 *   相槌・感嘆詞(issue #33)を落とす
 * - `filterTranslationArtifactTerms`: 逆方向 Pick up(機械翻訳の訳文からの抽出)専用。訳文の誤訳・幻覚に
 *   由来しやすい固有名詞的な語句(大文字小文字の混在・大文字始まりのハイフン語)を落とす
 * - `filterForeignScriptMeaningTerms`: 意味テキストに解説言語で使わない文字種(キリル文字など)が
 *   混ざった語句を落とす(issue #98)
 * - `filterProperNounPhraseTerms`: 文中(先頭以外)に固有名詞的な語(大文字始まりかつ小文字を含む語)を
 *   含む語句を落とす(issue #100)
 * - `filterQuestionSentenceTerms`: 末尾が疑問符の複数語の語句(疑問文まるごとの抽出)を落とす(issue #100)
 */
import { describe, expect, it } from "vitest";
import {
  filterForeignScriptMeaningTerms,
  filterPickupTerms,
  filterProperNounPhraseTerms,
  filterQuestionSentenceTerms,
  filterTranslationArtifactTerms,
  preparePickupInput,
} from "./pickup-filter";
import type { EmotePosition } from "@/lib/twitch/irc-parser";

describe("preparePickupInput", () => {
  it("emote が無く特殊なトークンも無い本文はそのまま返す", () => {
    const prepared = preparePickupInput("bro is cooked lmao", []);

    expect(prepared).toEqual({ text: "bro is cooked lmao", emoteNames: [], mentionNames: [] });
  });

  it("emotes タグの位置にある emote 名を本文から除き、除いた emote 名を保持する", () => {
    // "xqcPeepo DID THAT NOT STICKY HIM" の xqcPeepo(0-7文字目)が emote
    const emotes: EmotePosition[] = [{ id: "emotesv2_1", start: 0, end: 7 }];

    const prepared = preparePickupInput("xqcPeepo DID THAT NOT STICKY HIM", emotes);

    expect(prepared.text).toBe("DID THAT NOT STICKY HIM");
    expect(prepared.emoteNames).toEqual(["xqcPeepo"]);
  });

  it("同じ emote が複数回登場しても emote 名は重複なく保持する", () => {
    const emotes: EmotePosition[] = [
      { id: "25", start: 0, end: 4 },
      { id: "25", start: 10, end: 14 },
    ];

    const prepared = preparePickupInput("Kappa lol Kappa", emotes);

    expect(prepared.text).toBe("lol");
    expect(prepared.emoteNames).toEqual(["Kappa"]);
  });

  it("emote だけの発言は本文が空文字列になる", () => {
    const emotes: EmotePosition[] = [{ id: "25", start: 0, end: 4 }];

    const prepared = preparePickupInput("Kappa", emotes);

    expect(prepared.text).toBe("");
    expect(prepared.emoteNames).toEqual(["Kappa"]);
  });

  it("@メンションを本文から除き、@ を外したユーザー名を保持する", () => {
    const prepared = preparePickupInput("@AUBREY that was a W", []);

    expect(prepared.text).toBe("that was a W");
    expect(prepared.mentionNames).toEqual(["AUBREY"]);
  });

  it("URL を本文から除く", () => {
    const prepared = preparePickupInput("check this https://example.com/clip lol", []);

    expect(prepared.text).toBe("check this lol");
  });

  it("除去によって生じた連続する空白は1つにまとめ、前後の空白を落とす", () => {
    const emotes: EmotePosition[] = [{ id: "25", start: 4, end: 8 }];

    const prepared = preparePickupInput("gg  Kappa  chat ", emotes);

    expect(prepared.text).toBe("gg chat");
  });
});

describe("filterPickupTerms", () => {
  const 前処理済み = { text: "DID THAT NOT STICKY HIM", emoteNames: ["xqcPeepo"], mentionNames: ["AUBREY"] };

  it("emote 名と一致する語句を落とす(大文字小文字は区別しない)", () => {
    const terms = [
      { term: "xqcpeepo", meaning: "特定の配信者関連の絵文字" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("@ で始まる語句と、@メンションのユーザー名と一致する語句を落とす", () => {
    const terms = [
      { term: "@AUBREY", meaning: "特定の視聴者への呼称" },
      { term: "aubrey", meaning: "特定の視聴者への呼称" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("文字を1つも含まない語句(数字や記号だけ)を落とす", () => {
    const terms = [
      { term: "67", meaning: "日付や時間を示す可能性" },
      { term: "10:30", meaning: "時刻" },
      { term: "???", meaning: "困惑" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("! で始まる語句(チャットコマンド)を落とす", () => {
    const terms = [
      { term: "!chimkin", meaning: "鶏肉のミーム" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("追加で指定した除外名(表示中の発言者名など)と一致する語句を落とす(大文字小文字は区別しない)", () => {
    const terms = [
      { term: "space_toilet_master", meaning: "配信の常連" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み, ["Space_Toilet_Master"])).toEqual([
      { term: "sticky", meaning: "スタン状態にする" },
    ]);
  });

  it("同じ語句が複数回返ってきた場合は最初の1件だけ残す(大文字小文字は区別しない)", () => {
    const terms = [
      { term: "sayuwuKuru", meaning: "意味不明な文字列" },
      { term: "sayuwukuru", meaning: "繰り返される" },
      { term: "sticky", meaning: "スタン状態にする" },
      { term: "sayuwuKuru", meaning: "意味不明な文字列" },
    ];

    expect(filterPickupTerms(terms, { text: "sayuwuKuru sticky", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "sayuwuKuru", meaning: "意味不明な文字列" },
      { term: "sticky", meaning: "スタン状態にする" },
    ]);
  });

  it("笑い声(haha / hahaha / hehe / HAHA)を落とし、略語の lol / lmao は残す(issue #30)", () => {
    const terms = [
      { term: "haha", meaning: "笑い声" },
      { term: "hahaha", meaning: "笑い声" },
      { term: "hehe", meaning: "軽い笑い" },
      { term: "HAHA", meaning: "笑い声" },
      { term: "hah", meaning: "笑い声" },
      { term: "lol", meaning: "爆笑" },
      { term: "lmao", meaning: "大爆笑" },
      { term: "put effort into", meaning: "〜に力を注ぐ" },
    ];

    expect(
      filterPickupTerms(terms, { text: "they put so much effort into it haha lol lmao", emoteNames: [], mentionNames: [] }),
    ).toEqual([
      { term: "lol", meaning: "爆笑" },
      { term: "lmao", meaning: "大爆笑" },
      { term: "put effort into", meaning: "〜に力を注ぐ" },
    ]);
  });

  it("前後に記号が付いた笑い声(haha! / (hehe) / hahaha...)も落とす", () => {
    const terms = [
      { term: "haha!", meaning: "笑い声" },
      { term: "(hehe)", meaning: "軽い笑い" },
      { term: "hahaha...", meaning: "笑い声" },
      { term: "lol!", meaning: "爆笑" },
    ];

    expect(filterPickupTerms(terms, { text: "haha! (hehe) hahaha... lol!", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "lol!", meaning: "爆笑" },
    ]);
  });

  it("普遍的な相槌・感嘆詞(oh / wow / hmm / ah / eh / uh / om)を落とし、略語やミーム(lol / pog)は残す(issue #33)", () => {
    const terms = [
      { term: "oh", meaning: "驚きを表す感嘆詞" },
      { term: "Wow", meaning: "驚きを表す感嘆詞" },
      { term: "hmm", meaning: "考え込むときの相槌" },
      { term: "ah", meaning: "納得したときの感嘆詞" },
      { term: "eh", meaning: "疑問を表す間投詞" },
      { term: "uh", meaning: "言いよどみ" },
      { term: "om", meaning: "驚きや興奮を表す感嘆詞" },
      { term: "lol", meaning: "爆笑" },
      { term: "pog", meaning: "すごい" },
    ];

    expect(filterPickupTerms(terms, { text: "oh Wow hmm ah eh uh om lol pog", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "lol", meaning: "爆笑" },
      { term: "pog", meaning: "すごい" },
    ]);
  });

  it("文字を伸ばした相槌・感嘆詞(ohhh / hmmm / wowww)、綴り揺れ(woah / eww)、前後に記号が付いた形(oh! / wow...)も落とす(issue #33)", () => {
    const terms = [
      { term: "ohhh", meaning: "驚きを表す感嘆詞" },
      { term: "hmmm", meaning: "考え込むときの相槌" },
      { term: "wowww", meaning: "驚きを表す感嘆詞" },
      { term: "woah", meaning: "驚きを表す感嘆詞" },
      { term: "eww", meaning: "嫌悪を表す感嘆詞" },
      { term: "oh!", meaning: "驚きを表す感嘆詞" },
      { term: "wow...", meaning: "驚きを表す感嘆詞" },
      { term: "cool", meaning: "かっこいい" },
    ];

    expect(filterPickupTerms(terms, { text: "ohhh hmmm wowww woah eww oh! wow... cool", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "cool", meaning: "かっこいい" },
    ]);
  });

  it("辞書の語に綴りが近いだけの語(ohm / uh-oh / boo / o7)は落とさない(issue #33)", () => {
    const terms = [
      { term: "ohm", meaning: "電気抵抗の単位" },
      { term: "uh-oh", meaning: "まずいことが起きたときの声" },
      { term: "boo", meaning: "ブーイング" },
      { term: "o7", meaning: "敬礼の顔文字" },
    ];

    expect(filterPickupTerms(terms, { text: "ohm uh-oh boo o7", emoteNames: [], mentionNames: [] })).toEqual(terms);
  });

  it("文字を伸ばした笑い声(hahaaa / HAHAHAAA)も落とす(issue #33)", () => {
    const terms = [
      { term: "hahaaa", meaning: "笑い声" },
      { term: "HAHAHAAA", meaning: "笑い声" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, { text: "hahaaa HAHAHAAA sticky", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "sticky", meaning: "スタン状態にする" },
    ]);
  });

  it("日本語型の笑い声(www / wwww / WWW / www!)を落とす(issue #97)", () => {
    const terms = [
      { term: "www", meaning: "日本語圏の笑い声" },
      { term: "wwww", meaning: "日本語圏の笑い声" },
      { term: "WWW", meaning: "日本語圏の笑い声" },
      { term: "www!", meaning: "日本語圏の笑い声" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, { text: "www wwww WWW www! sticky", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "sticky", meaning: "スタン状態にする" },
    ]);
  });

  it("全角の日本語型笑い声(ｗｗｗ / ＷＷＷ / 半角全角混在)も落とす(issue #97 のレビュー指摘)", () => {
    const terms = [
      { term: "ｗｗｗ", meaning: "日本語圏の笑い声" },
      { term: "ＷＷＷ", meaning: "日本語圏の笑い声" },
      { term: "wｗw", meaning: "日本語圏の笑い声" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, { text: "ｗｗｗ ＷＷＷ wｗw sticky", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "sticky", meaning: "スタン状態にする" },
    ]);
  });

  it("単独の W / ｗ(「勝ち」のスラング)や w を含む普通の語は落とさない(issue #97)", () => {
    const terms = [
      { term: "W", meaning: "勝利・最高" },
      { term: "ｗ", meaning: "勝利・最高" },
      { term: "wallow", meaning: "ふける" },
      { term: "big W", meaning: "大勝利" },
    ];

    expect(filterPickupTerms(terms, { text: "W ｗ wallow big W", emoteNames: [], mentionNames: [] })).toEqual(terms);
  });

  it("相槌・感嘆詞を含む複数語の表現(oh my god / wow factor)は落とさない(issue #33)", () => {
    const terms = [
      { term: "oh my god", meaning: "なんてこった" },
      { term: "wow factor", meaning: "驚かせる要素" },
    ];

    expect(filterPickupTerms(terms, { text: "oh my god wow factor", emoteNames: [], mentionNames: [] })).toEqual(terms);
  });

  it("落とす対象が無ければ元の配列と同じ内容を返す", () => {
    const terms = [{ term: "sticky", meaning: "スタン状態にする" }];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual(terms);
  });
});

describe("filterTranslationArtifactTerms", () => {
  // 実際に観測した誤り: 日本語チャット「エオルゼア」「タタルさんと遊んでた」を英訳した際に
  // 機械翻訳が "EoR" という実在しない略記や固有名詞込みの句を作り、Pick up がそれを教材にしてしまった

  it("2文字目以降に大文字を含み小文字も混在する語句(機械翻訳が作った固有名詞・偽の略記)を落とす", () => {
    const terms = [
      { term: "EoR", meaning: "Final Fantasy XIV略称(世界観)" },
      { term: "juggling with Tataru", meaning: "タタルとのやり取りを繰り返していた" },
      { term: "Becoming a Dragoon?!", meaning: "竜騎士になるの！？" },
      { term: "no cap", meaning: "嘘じゃない、マジで" },
    ];

    expect(filterTranslationArtifactTerms(terms, "en")).toEqual([{ term: "no cap", meaning: "嘘じゃない、マジで" }]);
  });

  it("文頭だけが大文字の語句(文頭に置かれただけの普通の表現)は落とさない", () => {
    const terms = [{ term: "Toss it!", meaning: "捨てる！" }];

    expect(filterTranslationArtifactTerms(terms, "en")).toEqual(terms);
  });

  it("全大文字の略語(LOL / GG)は落とさない", () => {
    const terms = [
      { term: "LOL", meaning: "爆笑" },
      { term: "GG", meaning: "good game の略、お疲れ" },
    ];

    expect(filterTranslationArtifactTerms(terms, "en")).toEqual(terms);
  });

  it("大文字で始まりハイフンを含む単語(訳文に残った音写・日本語の敬称)を含む語句を落とす", () => {
    const terms = [
      { term: "Conto-me", meaning: "話してくれ！(相槌の表現)" },
      { term: "Twitch-san", meaning: "Twitchの配信者への敬称" },
      { term: "uh-oh", meaning: "まずいことが起きたときの声" },
    ];

    expect(filterTranslationArtifactTerms(terms, "en")).toEqual([
      { term: "uh-oh", meaning: "まずいことが起きたときの声" },
    ]);
  });

  it("小文字だけの語句(通常のスラング・イディオム)は落とさない", () => {
    const terms = [
      { term: "no cap", meaning: "嘘じゃない、マジで" },
      { term: "making a mountain out of a molehill", meaning: "些細な事を大げさに捉える" },
    ];

    expect(filterTranslationArtifactTerms(terms, "en")).toEqual(terms);
  });

  it("既知のトレードオフ: 実在する混在ケースの語(iPhone / eBay)や大文字始まりの複合語(T-shirt / X-ray)も落ちる(綴りの形だけで判定するため。幻覚を学習者に見せない精度を優先)", () => {
    const terms = [
      { term: "iPhone", meaning: "Appleのスマートフォン" },
      { term: "eBay", meaning: "オークションサイト" },
      { term: "T-shirt", meaning: "Tシャツ" },
      { term: "X-ray", meaning: "レントゲン" },
    ];

    expect(filterTranslationArtifactTerms(terms, "en")).toEqual([]);
  });

  it("学ぶ言語がドイツ語の場合は名詞が常に大文字で書かれるため、何も落とさずそのまま返す", () => {
    const terms = [
      { term: "Feierabend machen", meaning: "仕事を切り上げる" },
      { term: "auf dem Schlauch stehen", meaning: "ピンとこない、理解できない" },
    ];

    expect(filterTranslationArtifactTerms(terms, "de")).toEqual(terms);
  });

  it("学ぶ言語が日本語の場合、ラテン文字を含まない語句はそのまま残す", () => {
    const terms = [{ term: "それな", meaning: "共感を表す相槌" }];

    expect(filterTranslationArtifactTerms(terms, "ja")).toEqual(terms);
  });
});

describe("filterForeignScriptMeaningTerms", () => {
  it("解説言語が日本語の場合、意味にキリル文字の単語が混入した語句を落とす(issue #98 の観測ケース)", () => {
    const terms = [
      { term: "clutch", meaning: "土壇場で決める направление こと" },
      { term: "gg", meaning: "good game の略。対戦後の挨拶" },
    ];

    expect(filterForeignScriptMeaningTerms(terms, "ja", "en")).toEqual([
      { term: "gg", meaning: "good game の略。対戦後の挨拶" },
    ]);
  });

  it("解説言語が日本語の場合、ひらがな・カタカナ・漢字・ラテン文字・数字・記号だけの意味はそのまま残す", () => {
    const terms = [
      { term: "cooked", meaning: "「終わった・ダメだ」を表すスラング" },
      { term: "W", meaning: "win(勝ち)の略。称賛にも使う" },
      { term: "poggers", meaning: "興奮・驚きを表すミーム(PogChamp 由来)" },
    ];

    expect(filterForeignScriptMeaningTerms(terms, "ja", "en")).toEqual(terms);
  });

  it("解説言語が英語の場合、キリル文字・アラビア文字を含む意味の語句を落とす", () => {
    const terms = [
      { term: "no cap", meaning: "means нет serious exaggeration" },
      { term: "based", meaning: "confident in one's own العربية views" },
      { term: "sus", meaning: "short for suspicious" },
    ];

    expect(filterForeignScriptMeaningTerms(terms, "en", "ja")).toEqual([
      { term: "sus", meaning: "short for suspicious" },
    ]);
  });

  it("学ぶ言語が日本語の場合、解説言語がラテン文字圏でも意味に引用された日本語の文字は許容する", () => {
    // 意味テキストが原文の語句(草 など)をそのまま引用するのは正当な出力のため落とさない
    const terms = [{ term: "草", meaning: "means lol (草 = grass, from wwww)" }];

    expect(filterForeignScriptMeaningTerms(terms, "en", "ja")).toEqual(terms);
  });

  it("解説言語・学ぶ言語のどちらにも日本語が無い場合、意味に日本語の文字が混ざった語句を落とす", () => {
    const terms = [{ term: "banger", meaning: "a great song 素晴らしい曲" }];

    expect(filterForeignScriptMeaningTerms(terms, "en", "es")).toEqual([]);
  });

  it("アクセント付きラテン文字・半角カタカナ・伸ばし棒・々などの記号的な文字は許容する", () => {
    const terms = [
      { term: "château", meaning: "フランス語由来の「城」。café のようなアクセント付き綴り" },
      { term: "kusa", meaning: "ｸｻ(草)ー。時々使われる笑いの表現" },
    ];

    expect(filterForeignScriptMeaningTerms(terms, "ja", "fr")).toEqual(terms);
  });

  it("絵文字・数字・記号は文字種の判定対象にしない", () => {
    const terms = [{ term: "7-2", meaning: "サッカーの大差スコア 😂 (7対2)" }];

    expect(filterForeignScriptMeaningTerms(terms, "ja", "en")).toEqual(terms);
  });
});

describe("filterProperNounPhraseTerms", () => {
  // issue #100 の観測ケース: 固有名詞(ブランド名・人名)は高頻度語リストに無いため
  // 「非高頻度語を含む複数語句」としてハイブリッドフィルタ(issue #95)を通過してしまう

  it("文中(先頭以外)に大文字始まりで小文字を含む語(固有名詞)がある語句を落とす", () => {
    const terms = [
      { term: "Do you mean Snickers?", meaning: "スニッカーズのこと?" },
      { term: "playing with Tataru", meaning: "タタルと遊ぶ" },
      { term: "no cap", meaning: "嘘じゃない、マジで" },
    ];

    expect(filterProperNounPhraseTerms(terms, "en")).toEqual([{ term: "no cap", meaning: "嘘じゃない、マジで" }]);
  });

  it("先頭の語だけが大文字始まりの語句(文頭に置かれただけの表現)は落とさない", () => {
    const terms = [
      { term: "Toss it!", meaning: "捨てる!" },
      { term: "Nice try", meaning: "惜しかったね" },
    ];

    expect(filterProperNounPhraseTerms(terms, "en")).toEqual(terms);
  });

  it("文中の全大文字の語(略語・強調)は固有名詞とみなさず残す", () => {
    const terms = [
      { term: "big W", meaning: "大勝利" },
      { term: "GG WP", meaning: "good game, well played の略" },
      { term: "actual LOL moment", meaning: "本当に声が出た場面" },
    ];

    expect(filterProperNounPhraseTerms(terms, "en")).toEqual(terms);
  });

  it("文中の語中に大文字を含む語(iPhone / eBay のようなブランド名)がある語句も落とす(CodeRabbit の指摘)", () => {
    const terms = [
      { term: "grab the iPhone", meaning: "iPhoneを手に取る" },
      { term: "selling on eBay", meaning: "eBayで売る" },
    ];

    expect(filterProperNounPhraseTerms(terms, "en")).toEqual([]);
  });

  it("一人称の I / I'm のような語は固有名詞とみなさず残す", () => {
    const terms = [
      { term: "what am I saying", meaning: "何を言ってるんだ俺は" },
      { term: "and I'm dead", meaning: "笑いすぎて死んだ(ミーム的表現)" },
    ];

    expect(filterProperNounPhraseTerms(terms, "en")).toEqual(terms);
  });

  it("表現リストに一致する語句はタイトルケースで書かれていても残す(誤殺の救済)", () => {
    // "what's up" は表現リスト収録。チャットがタイトルケースで書かれても落とさない
    const terms = [{ term: "What's Up", meaning: "調子どう?(挨拶)" }];

    expect(filterProperNounPhraseTerms(terms, "en")).toEqual(terms);
  });

  it("先頭の1語だけの語句は対象外として残す(文頭と固有名詞を区別できないため)", () => {
    const terms = [{ term: "Snickers", meaning: "チョコバーのブランド" }];

    expect(filterProperNounPhraseTerms(terms, "en")).toEqual(terms);
  });

  it("学ぶ言語がドイツ語の場合は名詞が常に大文字で書かれるため、何も落とさずそのまま返す", () => {
    const terms = [
      { term: "die Daumen drücken", meaning: "幸運を祈る" },
      { term: "auf dem Schlauch stehen", meaning: "ピンとこない" },
    ];

    expect(filterProperNounPhraseTerms(terms, "de")).toEqual(terms);
  });
});

describe("filterQuestionSentenceTerms", () => {
  // issue #100 の観測ケース: 疑問文などの発言ほぼ全体が1つの「表現」として返る

  it("末尾が疑問符でリスト外の複数語の語句(疑問文まるごとの抽出)を落とす", () => {
    const terms = [
      { term: "are you malding right now?", meaning: "今キレてるの?" },
      { term: "malding", meaning: "ハゲるほどキレること" },
    ];

    expect(filterQuestionSentenceTerms(terms)).toEqual([{ term: "malding", meaning: "ハゲるほどキレること" }]);
  });

  it("全角の疑問符(？)で終わる複数語の語句も落とす(機械翻訳の訳文に残るケース)", () => {
    const terms = [{ term: "do you like this game？", meaning: "このゲーム好き?" }];

    expect(filterQuestionSentenceTerms(terms)).toEqual([]);
  });

  it("疑問符に感嘆符が続く形(?! / ？！)で終わる複数語の語句も落とす(CodeRabbit の指摘)", () => {
    const terms = [
      { term: "are you serious?!", meaning: "マジで言ってる!?" },
      { term: "is this real？！", meaning: "これ現実!?" },
    ];

    expect(filterQuestionSentenceTerms(terms)).toEqual([]);
  });

  it("表現リストに一致する疑問形の定型表現は疑問符付きでも残す(誤殺の救済)", () => {
    const terms = [{ term: "what's up?", meaning: "調子どう?(挨拶)" }];

    expect(filterQuestionSentenceTerms(terms)).toEqual(terms);
  });

  it("1語の語句は疑問符付きでも残す(単語の聞き返しは学習価値があるため)", () => {
    const terms = [{ term: "Pardon?", meaning: "もう一度言って?(聞き返し)" }];

    expect(filterQuestionSentenceTerms(terms)).toEqual(terms);
  });

  it("疑問符で終わらない語句はそのまま残す", () => {
    const terms = [
      { term: "no cap", meaning: "嘘じゃない、マジで" },
      { term: "let him cook", meaning: "彼にやらせておけ(ミーム)" },
    ];

    expect(filterQuestionSentenceTerms(terms)).toEqual(terms);
  });
});
