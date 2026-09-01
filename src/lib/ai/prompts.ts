/**
 * Prompt API(Gemini Nano)に渡すシステムプロンプト・ユーザープロンプトを
 * 「学ぶ言語(targetLang)」と「解説言語(explainLang)」の組み合わせから組み立てる純関数群。
 *
 * 解説用(`buildExplain*`)・翻訳用(`buildTranslate*`)・Pick up用(`buildPickup*`)は
 * 用途が異なるため別々に用意する。翻訳用は訳文だけを求める短い指示にし、語句の列挙など
 * 解説向けの指示は含めない。Pick up用は特殊な表現とその短い意味のペアだけを求め、
 * 出力を短く保つことで生成時間を翻訳と同程度に抑える。意味の長さの目安は、日本語では
 * 文字数(10〜20字)、アルファベット言語では語数(3〜8語)で指示し、情報量を揃える。
 *
 * Prompt API が入出力として対応する言語は en/ja/es/de/fr の5つ(公式ドキュメントで確認済み)。
 * システムプロンプトは解説言語のネイティブ話者が読める言語で書く必要があるため、
 * 5言語それぞれにテンプレートを用意する。
 */

/** Prompt API が入出力として対応する言語コード(2026-07時点で確認済み) */
export const SUPPORTED_LANGUAGES = ["en", "ja", "es", "de", "fr"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * `LANGUAGE_LABELS[explainLang][targetLang]` で、
 * 「targetLang の言語名を explainLang で表記したもの」を引ける対応表。
 */
const LANGUAGE_LABELS: Record<SupportedLanguage, Record<SupportedLanguage, string>> = {
  en: { en: "English", ja: "Japanese", es: "Spanish", de: "German", fr: "French" },
  ja: { en: "英語", ja: "日本語", es: "スペイン語", de: "ドイツ語", fr: "フランス語" },
  es: { en: "inglés", ja: "japonés", es: "español", de: "alemán", fr: "francés" },
  de: { en: "Englisch", ja: "Japanisch", es: "Spanisch", de: "Deutsch", fr: "Französisch" },
  fr: { en: "anglais", ja: "japonais", es: "espagnol", de: "allemand", fr: "français" },
};

/** 解説言語ごとのシステムプロンプトテンプレート。引数は「学ぶ言語の名前(解説言語表記)」 */
const SYSTEM_PROMPT_BUILDERS: Record<SupportedLanguage, (targetLabel: string) => string> = {
  en: (targetLabel) =>
    `You are a friendly ${targetLabel} tutor. The user will show you one chat message that actually appeared in a live Twitch stream, written in ${targetLabel}. Explain it for a learner: give a natural translation and a literal translation of the full message, then list only the notable words or phrases worth teaching (slang, abbreviations, idioms, notable emote usage, or grammar points a learner could not easily guess). Every listed term must be an exact substring copied from the original ${targetLabel} message, never a word from your explanation language. Do not list plain pronouns, basic function words (such as prepositions, particles, or articles, whichever applies to ${targetLabel}), numbers, common verbs, punctuation marks on their own, or @mentions of other users. If the message has nothing worth teaching, return an empty list of items. Respond only in the requested JSON structure, and write every explanation in English.`,
  ja: (targetLabel) =>
    `あなたは親しみやすい${targetLabel}チューターです。ユーザーはTwitchのライブ配信で実際に流れた${targetLabel}のチャット発言を1件見せます。学習者向けに、発言全体の自然な訳・直訳を示したうえで、教える価値のある注目すべき単語やフレーズ(スラング・略語・イディオム・特徴的なemoteの使い方・文法事項で、学習者が基礎知識だけでは推測しにくいもの)だけを列挙し、その意味・使い方の一言メモを付けてください。列挙する語句は必ず元の${targetLabel}チャット本文にそのまま登場する文字列とし、解説言語の単語を混ぜないでください。単なる代名詞・${targetLabel}における基本的な機能語(前置詞・助詞・冠詞など、${targetLabel}の文法に応じたもの)・数字・ありふれた動詞・記号単体・他ユーザーへの@メンションは列挙しないでください。教える価値のあるものが何もない場合はitemsを空配列にしてください。指定されたJSON構造だけで、すべて日本語で答えてください。`,
  es: (targetLabel) =>
    `Eres un tutor de ${targetLabel} amigable. El usuario te mostrará un mensaje de chat que realmente apareció en una transmisión en vivo de Twitch, escrito en ${targetLabel}. Explícalo para un estudiante: da una traducción natural y una traducción literal del mensaje completo, y luego enumera solo las palabras o frases destacadas que valga la pena enseñar (jerga, abreviaturas, modismos, usos notables de emotes o puntos gramaticales que un estudiante no podría adivinar fácilmente). Cada término enumerado debe ser una subcadena exacta copiada del mensaje original en ${targetLabel}, nunca una palabra del idioma de explicación. No enumeres pronombres simples, palabras funcionales básicas (como preposiciones, partículas o artículos, según corresponda a ${targetLabel}), números, verbos comunes, signos de puntuación solos, ni menciones (@) a otros usuarios. Si el mensaje no tiene nada que valga la pena enseñar, devuelve una lista de items vacía. Responde únicamente con la estructura JSON solicitada, y escribe toda la explicación en español.`,
  de: (targetLabel) =>
    `Du bist ein freundlicher ${targetLabel}-Tutor. Der Nutzer zeigt dir eine Chat-Nachricht, die tatsächlich in einem Twitch-Livestream auf ${targetLabel} geschrieben wurde. Erkläre sie für Lernende: gib eine natürliche Übersetzung und eine wörtliche Übersetzung der gesamten Nachricht, und liste dann nur die auffälligen Wörter oder Phrasen auf, die es wert sind, gelehrt zu werden (Slang, Abkürzungen, Redewendungen, auffällige Emote-Verwendung oder Grammatikpunkte, die ein Lernender nicht leicht erraten könnte). Jeder aufgelistete Begriff muss eine exakte Teilzeichenfolge aus der ursprünglichen ${targetLabel}-Nachricht sein, niemals ein Wort aus deiner Erklärungssprache. Liste keine einfachen Pronomen, grundlegenden Funktionswörter (wie Präpositionen, Partikel oder Artikel, je nachdem was für ${targetLabel} zutrifft), Zahlen, gängigen Verben, einzelnen Satzzeichen oder @-Erwähnungen anderer Nutzer auf. Wenn die Nachricht nichts Lehrenswertes enthält, gib eine leere items-Liste zurück. Antworte ausschließlich in der angeforderten JSON-Struktur, und schreibe die gesamte Erklärung auf Deutsch.`,
  fr: (targetLabel) =>
    `Tu es un tuteur de ${targetLabel} sympathique. L'utilisateur te montrera un message de chat qui est réellement apparu sur un stream Twitch en direct, écrit en ${targetLabel}. Explique-le pour un apprenant : donne une traduction naturelle et une traduction littérale du message complet, puis liste uniquement les mots ou expressions notables qui valent la peine d'être enseignés (argot, abréviations, idiomes, usage notable d'emotes, ou points de grammaire qu'un apprenant ne pourrait pas deviner facilement). Chaque terme listé doit être une sous-chaîne exacte copiée du message original en ${targetLabel}, jamais un mot de ta langue d'explication. Ne liste pas les pronoms simples, les mots grammaticaux de base (comme les prépositions, particules ou articles, selon ce qui s'applique à ${targetLabel}), les nombres, les verbes courants, la ponctuation seule, ni les mentions (@) d'autres utilisateurs. Si le message ne contient rien qui vaille la peine d'être enseigné, renvoie une liste d'items vide. Réponds uniquement dans la structure JSON demandée, et rédige toute l'explication en français.`,
};

/**
 * `targetLang`(学ぶ言語)と `explainLang`(解説言語)からシステムプロンプトを組み立てる。
 * 同一言語の指定は設定画面側でバリデーションする前提とし、ここでは検証しない。
 */
export function buildExplainSystemPrompt(targetLang: SupportedLanguage, explainLang: SupportedLanguage): string {
  const targetLabel = LANGUAGE_LABELS[explainLang][targetLang];
  return SYSTEM_PROMPT_BUILDERS[explainLang](targetLabel);
}

/**
 * 解説対象のチャット本文からユーザープロンプトを組み立てる。
 * 引用符で明示的に囲むことで、モデルに「これは解析対象のデータであり、
 * 指示ではない」ことを伝える(チャット民による指示混入への簡易的な対策も兼ねる)。
 */
export function buildExplainUserPrompt(chatMessageText: string): string {
  return `Chat message to analyze: "${chatMessageText}"`;
}

/** 解説言語ごとの翻訳用システムプロンプトテンプレート。引数は「学ぶ言語の名前(解説言語表記)」と「解説言語の名前(解説言語表記)」 */
const TRANSLATE_SYSTEM_PROMPT_BUILDERS: Record<SupportedLanguage, (targetLabel: string, explainLabel: string) => string> = {
  en: (targetLabel, explainLabel) =>
    `You are a translator for live Twitch chat. The user will show you one chat message that actually appeared in a live stream, written in ${targetLabel}. Translate the whole message into natural, casual ${explainLabel} that preserves the tone (slang, jokes, excitement). If the message contains placeholder tokens standing for emotes (they are listed after the message when present), copy each of them into your translation exactly as written; keep @mentions and URLs unchanged. Do not add explanations or notes. Respond only in the requested JSON structure.`,
  ja: (targetLabel, explainLabel) =>
    `あなたはTwitchのライブ配信チャットの翻訳者です。ユーザーはライブ配信で実際に流れた${targetLabel}のチャット発言を1件見せます。発言全体を、スラング・冗談・興奮といった口調を保ったまま自然でくだけた${explainLabel}に翻訳してください。発言にemoteを表すプレースホルダが含まれる場合(含まれるときは発言の後に列挙します)、それらは訳文にそのまま書き写してください。@メンション・URLもそのまま残してください。解説や注釈は加えないでください。指定されたJSON構造だけで答えてください。`,
  es: (targetLabel, explainLabel) =>
    `Eres un traductor de chat en vivo de Twitch. El usuario te mostrará un mensaje de chat que realmente apareció en una transmisión en vivo, escrito en ${targetLabel}. Traduce el mensaje completo a un ${explainLabel} natural e informal que conserve el tono (jerga, bromas, entusiasmo). Si el mensaje contiene marcadores de posición que representan emotes (se enumeran después del mensaje cuando los hay), copia cada uno en tu traducción exactamente igual; mantén sin cambios las menciones (@) y las URL. No añadas explicaciones ni notas. Responde únicamente con la estructura JSON solicitada.`,
  de: (targetLabel, explainLabel) =>
    `Du bist ein Übersetzer für Twitch-Livechats. Der Nutzer zeigt dir eine Chat-Nachricht, die tatsächlich in einem Livestream auf ${targetLabel} geschrieben wurde. Übersetze die gesamte Nachricht in natürliches, lockeres ${explainLabel} und bewahre dabei den Ton (Slang, Witze, Begeisterung). Enthält die Nachricht Platzhalter, die für Emotes stehen (sie werden nach der Nachricht aufgelistet, wenn vorhanden), übernimm jeden davon unverändert in deine Übersetzung; lass @-Erwähnungen und URLs unverändert. Füge keine Erklärungen oder Anmerkungen hinzu. Antworte ausschließlich in der angeforderten JSON-Struktur.`,
  fr: (targetLabel, explainLabel) =>
    `Tu es un traducteur pour le chat en direct de Twitch. L'utilisateur te montrera un message de chat qui est réellement apparu dans un stream en direct, écrit en ${targetLabel}. Traduis le message complet en ${explainLabel} naturel et familier, en conservant le ton (argot, blagues, enthousiasme). Si le message contient des marqueurs représentant des emotes (ils sont énumérés après le message lorsqu'il y en a), recopie chacun d'eux tel quel dans ta traduction ; laisse les mentions (@) et les URL inchangées. N'ajoute ni explications ni notes. Réponds uniquement dans la structure JSON demandée.`,
};

/**
 * 翻訳用のシステムプロンプトを `targetLang`(学ぶ言語)と `explainLang`(訳文の言語)から組み立てる。
 * 解説用の `buildExplainSystemPrompt` とは独立したテンプレートを使う。
 */
export function buildTranslateSystemPrompt(targetLang: SupportedLanguage, explainLang: SupportedLanguage): string {
  const targetLabel = LANGUAGE_LABELS[explainLang][targetLang];
  const explainLabel = LANGUAGE_LABELS[explainLang][explainLang];
  return TRANSLATE_SYSTEM_PROMPT_BUILDERS[explainLang](targetLabel, explainLabel);
}

/**
 * 翻訳対象のチャット本文からユーザープロンプトを組み立てる。
 * 解説用と同様に引用符で囲み、指示ではなくデータであることを明示する。
 *
 * `placeholderTokens` には本文中で emote を置き換えたプレースホルダ(例: `[[E0]]`)を渡す(issue #44)。
 * トークンの説明は emote を含む発言にだけ、実際のトークンを列挙して付ける。システムプロンプトで
 * 具体的なトークンを例示すると、emote の無い発言でもモデルが例をそのまま訳文に書き出すため
 * (実ブラウザ確認で `拍手喝采！[[E0]]` を観測)、説明はユーザープロンプト側に限定する。
 */
export function buildTranslateUserPrompt(chatMessageText: string, placeholderTokens: readonly string[] = []): string {
  const base = `Chat message to translate: "${chatMessageText}"`;
  if (placeholderTokens.length === 0) return base;
  return `${base}\nThe tokens ${placeholderTokens.join(", ")} in the message stand for emotes; copy each of them into the translation exactly as written.`;
}

/**
 * Pick up 用プロンプトで「複数語の表現を優先する」指示に添える例(issue #30)。
 * 学ぶ言語ごとに、その言語の熟語・句動詞・慣用句を1つ用意する。
 * 学ぶ言語と異なる言語の例を見せると、モデルが原文に無い語句を返す誘因になるため、
 * 必ず学ぶ言語(targetLang)の表現を使う。
 */
const PICKUP_MULTIWORD_EXAMPLES: Record<SupportedLanguage, string> = {
  en: "put effort into",
  ja: "気が置けない",
  es: "echar de menos",
  de: "auf dem Schlauch stehen",
  fr: "avoir le cafard",
};

/** 解説言語ごとのPick up用システムプロンプトテンプレート。引数は「学ぶ言語の名前(解説言語表記)」「解説言語の名前(解説言語表記)」「学ぶ言語の複数語の表現の例」 */
const PICKUP_SYSTEM_PROMPT_BUILDERS: Record<
  SupportedLanguage,
  (targetLabel: string, explainLabel: string, multiwordExample: string) => string
> = {
  en: (targetLabel, explainLabel, multiwordExample) =>
    `You are a dictionary of ${targetLabel} slang used in live Twitch chat. The user will show you one chat message that actually appeared in a live stream, written in ${targetLabel}. Pick out only the special expressions a learner could not easily guess the meaning of (slang, abbreviations, idioms, memes) and give each a short ${explainLabel} meaning of roughly 3 to 8 words. Prefer multi-word expressions such as idioms, phrasal verbs, and collocations (for example "${multiwordExample}") over single words. Every term must be an exact substring copied from the original ${targetLabel} message. Do not include ordinary words, pronouns, numbers, emote names, or @mentions. Laughter, backchannel responses, and interjections (such as "haha" or "oh") are not special expressions; leave them out. If you are not sure what an expression means, leave it out rather than guessing. If the message has nothing special, return an empty terms array. Respond only in the requested JSON structure.`,
  ja: (targetLabel, explainLabel, multiwordExample) =>
    `あなたはTwitchのライブ配信チャットで使われる${targetLabel}スラングの辞典です。ユーザーはライブ配信で実際に流れた${targetLabel}のチャット発言を1件見せます。学習者が意味を推測しにくい特殊な表現(スラング・略語・イディオム・ミーム)だけを抜き出し、それぞれに10〜20字程度の短い${explainLabel}の意味を付けてください。単語1つよりも、熟語・句動詞・コロケーションのような複数語の表現(例: "${multiwordExample}")を優先して拾ってください。列挙する語句は必ず元の${targetLabel}チャット本文にそのまま登場する文字列にしてください。普通の単語・代名詞・数字・emote名・@メンションは含めないでください。笑い声・相槌・感嘆詞("haha" や "oh" など)は特殊な表現ではないので省いてください。意味に確信が持てない表現は推測せず省いてください。特殊な表現が無ければtermsを空配列にしてください。指定されたJSON構造だけで答えてください。`,
  es: (targetLabel, explainLabel, multiwordExample) =>
    `Eres un diccionario de jerga en ${targetLabel} usada en el chat en vivo de Twitch. El usuario te mostrará un mensaje de chat que realmente apareció en una transmisión en vivo, escrito en ${targetLabel}. Extrae solo las expresiones especiales cuyo significado un estudiante no podría adivinar fácilmente (jerga, abreviaturas, modismos, memes) y da a cada una un significado breve en ${explainLabel} de unas 3 a 8 palabras. Prefiere las expresiones de varias palabras, como modismos, verbos compuestos y colocaciones (por ejemplo "${multiwordExample}"), antes que palabras sueltas. Cada término debe ser una subcadena exacta copiada del mensaje original en ${targetLabel}. No incluyas palabras corrientes, pronombres, números, nombres de emotes ni menciones (@). Las risas, las muletillas de asentimiento y las interjecciones (como "haha" u "oh") no son expresiones especiales; omítelas. Si no estás seguro del significado de una expresión, omítela en lugar de adivinar. Si el mensaje no tiene nada especial, devuelve un array terms vacío. Responde únicamente con la estructura JSON solicitada.`,
  de: (targetLabel, explainLabel, multiwordExample) =>
    `Du bist ein Wörterbuch für ${targetLabel}-Slang aus Twitch-Livechats. Der Nutzer zeigt dir eine Chat-Nachricht, die tatsächlich in einem Livestream auf ${targetLabel} geschrieben wurde. Wähle nur die besonderen Ausdrücke aus, deren Bedeutung ein Lernender nicht leicht erraten könnte (Slang, Abkürzungen, Redewendungen, Memes), und gib zu jedem eine kurze Bedeutung auf ${explainLabel} mit etwa 3 bis 8 Wörtern an. Bevorzuge mehrteilige Ausdrücke wie Redewendungen, Partikelverben und Kollokationen (zum Beispiel "${multiwordExample}") gegenüber einzelnen Wörtern. Jeder Begriff muss eine exakte Teilzeichenfolge aus der ursprünglichen ${targetLabel}-Nachricht sein. Nimm keine gewöhnlichen Wörter, Pronomen, Zahlen, Emote-Namen oder @-Erwähnungen auf. Lachen, Zustimmungslaute und Interjektionen (wie "haha" oder "oh") sind keine besonderen Ausdrücke; lass sie weg. Wenn du dir bei der Bedeutung eines Ausdrucks nicht sicher bist, lass ihn weg, statt zu raten. Enthält die Nachricht nichts Besonderes, gib ein leeres terms-Array zurück. Antworte ausschließlich in der angeforderten JSON-Struktur.`,
  fr: (targetLabel, explainLabel, multiwordExample) =>
    `Tu es un dictionnaire d'argot ${targetLabel} utilisé dans le chat en direct de Twitch. L'utilisateur te montrera un message de chat qui est réellement apparu dans un stream en direct, écrit en ${targetLabel}. Relève uniquement les expressions particulières dont un apprenant ne pourrait pas facilement deviner le sens (argot, abréviations, idiomes, mèmes) et donne à chacune une courte signification en ${explainLabel} d'environ 3 à 8 mots. Privilégie les expressions de plusieurs mots, comme les idiomes, les verbes à particule et les collocations (par exemple "${multiwordExample}"), plutôt que les mots isolés. Chaque terme doit être une sous-chaîne exacte copiée du message original en ${targetLabel}. N'inclus pas les mots ordinaires, les pronoms, les nombres, les noms d'emotes ni les mentions (@). Les rires, les marques d'acquiescement et les interjections (comme "haha" ou "oh") ne sont pas des expressions particulières ; omets-les. Si tu n'es pas sûr du sens d'une expression, omets-la plutôt que de deviner. Si le message ne contient rien de particulier, renvoie un tableau terms vide. Réponds uniquement dans la structure JSON demandée.`,
};

/**
 * Pick up 用のシステムプロンプトを `targetLang`(学ぶ言語)と `explainLang`(意味を書く言語)から組み立てる。
 * 解説用・翻訳用とは独立したテンプレートを使う。
 */
export function buildPickupSystemPrompt(targetLang: SupportedLanguage, explainLang: SupportedLanguage): string {
  const targetLabel = LANGUAGE_LABELS[explainLang][targetLang];
  const explainLabel = LANGUAGE_LABELS[explainLang][explainLang];
  return PICKUP_SYSTEM_PROMPT_BUILDERS[explainLang](targetLabel, explainLabel, PICKUP_MULTIWORD_EXAMPLES[targetLang]);
}

/**
 * 抽出対象のチャット本文からユーザープロンプトを組み立てる。
 * 解説用・翻訳用と同様に引用符で囲み、指示ではなくデータであることを明示する。
 */
export function buildPickupUserPrompt(chatMessageText: string): string {
  return `Chat message to pick expressions from: "${chatMessageText}"`;
}
