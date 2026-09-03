/**
 * ヘッダーに常時表示する、言語ペア(学ぶ言語 / 解説言語)のセレクト。
 *
 * 「Learning [学ぶ言語] · explained in [解説言語]」という文章の中にセレクトを埋め込む
 * 文章型レイアウトにすることで、各セレクトが何を意味するか(何の言語を学び、どの言語で
 * 解説が出るか)をラベルなしでも読み取れるようにしている。ラベルは sr-only で保持し、
 * スクリーンリーダー向けのアクセシブル名は維持する。
 *
 * - 変更は即座に `useSettingsStore.setSettings` が LocalStorage へ永続化し、ホーム画面が
 *   設定変更を購読して翻訳・Pick up のパイプラインを新しい言語ペアで再起動する
 * - 学ぶ言語と解説言語が同じペアはスキーマ(`settingsSchema`)で禁止されているため、
 *   もう一方と同じ言語を選んだ場合は両者を入れ替えて保存する(翻訳ツールの言語スワップと同じ挙動。
 *   両セレクトが並んで見えているため、入れ替わりは利用者に即座に伝わる)
 * - ストアが LocalStorage から未復元の間(`hydrated === false`)は無効化し、
 *   復元前にデフォルト値で永続化済みの設定を上書きしてしまう事故を防ぐ
 */
"use client";

import { z } from "zod";
import { Label } from "@/components/ui/label";
import { SUPPORTED_LANGUAGES } from "@/lib/ai/prompts";
import { LANGUAGE_DISPLAY_NAMES, type Settings } from "@/lib/settings";
import { useSettingsStore } from "@/store/settings";

const LEARNING_SELECT_ID = "learning-language-select";
const EXPLANATION_SELECT_ID = "explanation-language-select";
/** セレクトの値(文字列)を対応言語コードに検証する。対応外の値は Fail-Fast で例外にする */
const languageSchema = z.enum(SUPPORTED_LANGUAGES);

const SELECT_CLASS_NAME = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30";

/**
 * 学ぶ言語・解説言語の2つのセレクトを「Learning [X] · explained in [Y]」という
 * 文章の中に埋め込んで表示する。
 */
export function LanguagePairSelect() {
  const settings = useSettingsStore((state) => state.settings);
  const hydrated = useSettingsStore((state) => state.hydrated);
  const setSettings = useSettingsStore((state) => state.setSettings);

  /**
   * 片方のセレクトの変更を設定に反映する。もう一方と同じ言語を選んだ場合は両者を入れ替える。
   * スキーマ検証は `setSettings`(→ `saveSettings`)が必ず行うため、ここでは重複して検証しない
   */
  const handleChange = (field: "learningLang" | "explainLang") => (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = languageSchema.parse(event.target.value);
    const other = field === "learningLang" ? settings.explainLang : settings.learningLang;
    const next: Settings =
      value === other
        ? { ...settings, learningLang: settings.explainLang, explainLang: settings.learningLang }
        : field === "learningLang"
          ? { ...settings, learningLang: value }
          : { ...settings, explainLang: value };
    setSettings(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted-foreground">
      <Label htmlFor={LEARNING_SELECT_ID} className="sr-only">
        Learning language
      </Label>
      <span aria-hidden="true">Learning</span>
      <LanguageSelect
        id={LEARNING_SELECT_ID}
        value={settings.learningLang}
        disabled={!hydrated}
        onChange={handleChange("learningLang")}
      />
      <Label htmlFor={EXPLANATION_SELECT_ID} className="sr-only">
        Explanation language
      </Label>
      <span aria-hidden="true">·</span>
      <span aria-hidden="true">explained in</span>
      <LanguageSelect
        id={EXPLANATION_SELECT_ID}
        value={settings.explainLang}
        disabled={!hydrated}
        onChange={handleChange("explainLang")}
      />
    </div>
  );
}

/** サポート言語をネイティブ表記で並べる共通のセレクト */
function LanguageSelect({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <select id={id} className={SELECT_CLASS_NAME} value={value} disabled={disabled} onChange={onChange}>
      {SUPPORTED_LANGUAGES.map((lang) => (
        <option key={lang} value={lang}>
          {LANGUAGE_DISPLAY_NAMES[lang]}
        </option>
      ))}
    </select>
  );
}
