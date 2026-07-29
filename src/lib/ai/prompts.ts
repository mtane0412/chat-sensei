/**
 * Prompt API(Gemini Nano)に渡すシステムプロンプト・ユーザープロンプトを
 * 「学ぶ言語(targetLang)」と「解説言語(explainLang)」の組み合わせから組み立てる純関数群。
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

/**
 * 自動抽出パイプラインのtriage(学習価値判定)用ユーザープロンプトを組み立てる。
 * triage は explain と同じベースセッション(1セッションのみという設計)を共有するため、
 * システムプロンプトを切り替えず、このユーザープロンプト内でタスクを完結させる。
 * `responseConstraint` が真偽値を強制するため出力形式自体は壊れないが、
 * 判定基準を明示することで真偽の精度を上げる狙いがある。
 */
export function buildTriageUserPrompt(chatMessageText: string): string {
  return `You will judge ONE chat message that actually appeared in a live Twitch stream. Decide whether it contains something worth teaching a language learner, such as slang, an abbreviation, an idiom, a notable emote usage, or a notable grammar point. Respond true only if the message contains a specific word or phrase a learner could not easily guess from basic vocabulary. Respond false if it is just plain conversation, a greeting, a simple reaction, noise with nothing new to learn, a message that is only an @mention of another user with no other substantial content, or a message made up only of basic vocabulary a beginner already knows (pronouns, simple prepositions, numbers, common verbs). Chat message to judge: "${chatMessageText}"`;
}
