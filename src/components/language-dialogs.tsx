/**
 * 3カラム画面の列見出しから開く言語設定ダイアログ。
 *
 * 言語は配信ごとに異なる(英語配信・日英混在のチャットなど)ため、アプリ全体の設定(歯車)ではなく
 * 対象となる列の見出しから素早く切り替えられるようにする。
 *
 * - `LearningLanguagesDialog`: 生IRC列の見出しに置く。学ぶ言語(翻訳・Pick up の対象にする原文の言語)を
 *   チェックボックスで複数選ぶ。1つも選ばない設定は `settingsSchema` が拒否するため、エラーを表示して保存しない
 * - `ExplanationLanguageDialog`: 翻訳列の見出しに置く。解説言語(訳文・Pick up の意味の言語)をセレクトで 1 つ選ぶ
 *
 * 学ぶ言語と解説言語が同じ組み合わせは禁止しない。解説言語と同じ言語の発言は、パイプライン側が
 * Language Detector の判定で「同じ言語」としてスキップする(`store/auto-pipeline.ts`)。
 *
 * 保存は `useSettingsStore.setSettings` が LocalStorage へ永続化し、ホーム画面が言語設定の変更を購読して
 * 翻訳・Pick up のパイプラインを新しい設定で再起動する。ストアが LocalStorage から未復元の間
 * (`hydrated === false`)はトリガーを無効にし、デフォルト設定で永続化済みの設定を上書きしてしまう事故を防ぐ。
 */
"use client";

import { useState } from "react";
import { z } from "zod";
import { LanguagesIcon, MessageSquareTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/lib/ai/prompts";
import { LANGUAGE_DISPLAY_NAMES, settingsSchema } from "@/lib/settings";
import { useSettingsStore } from "@/store/settings";

const LEARNING_DIALOG_TITLE = "Learning languages";
const EXPLANATION_DIALOG_TITLE = "Explanation language";
const EXPLANATION_SELECT_ID = "explanation-language-select";
/** セレクトの値(文字列)を対応言語コードに検証する。対応外の値は Fail-Fast で例外にする */
const languageSchema = z.enum(SUPPORTED_LANGUAGES);

/** 生IRC列の見出しから開く、学ぶ言語(複数)のダイアログ */
export function LearningLanguagesDialog() {
  const settings = useSettingsStore((state) => state.settings);
  const hydrated = useSettingsStore((state) => state.hydrated);
  const setSettings = useSettingsStore((state) => state.setSettings);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SupportedLanguage[]>(settings.learningLangs);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    // 開くたびにストアの現在値から下書きを作り直す(前回の未保存の編集・エラーを持ち越さない)
    if (nextOpen) {
      setDraft(settings.learningLangs);
      setSaveError(null);
    }
    setOpen(nextOpen);
  };

  const toggle = (lang: SupportedLanguage, checked: boolean) => {
    // 表示順(SUPPORTED_LANGUAGES の順)を保って保存できるよう、チェック状態から並べ直す
    setDraft((prev) => SUPPORTED_LANGUAGES.filter((item) => (item === lang ? checked : prev.includes(item))));
  };

  const handleSave = () => {
    const validation = settingsSchema.safeParse({ ...settings, learningLangs: draft });
    if (!validation.success) {
      setSaveError(validation.error.issues[0]?.message ?? "Invalid settings");
      return;
    }
    setSettings(validation.data);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={LEARNING_DIALOG_TITLE} disabled={!hydrated} />}
      >
        <LanguagesIcon />
      </DialogTrigger>
      <DialogContent aria-label={LEARNING_DIALOG_TITLE}>
        <DialogHeader>
          <DialogTitle>{LEARNING_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>
            Choose the languages you are learning. Messages in these languages are translated and picked up; messages in
            the explanation language or any other language are left as they are. Saving regenerates the translations
            and Pick ups for the messages currently shown.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{LEARNING_DIALOG_TITLE}</legend>
          {SUPPORTED_LANGUAGES.map((lang) => {
            const id = `learning-language-${lang}`;
            return (
              <div key={lang} className="flex items-center gap-2">
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={draft.includes(lang)}
                  onChange={(e) => toggle(lang, e.target.checked)}
                />
                <Label htmlFor={id}>{LANGUAGE_DISPLAY_NAMES[lang]}</Label>
              </div>
            );
          })}
        </fieldset>

        {saveError && (
          <p className="text-xs text-destructive" role="alert">
            {saveError}
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 翻訳列の見出しから開く、解説言語(1つ)のダイアログ */
export function ExplanationLanguageDialog() {
  const settings = useSettingsStore((state) => state.settings);
  const hydrated = useSettingsStore((state) => state.hydrated);
  const setSettings = useSettingsStore((state) => state.setSettings);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SupportedLanguage>(settings.explainLang);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setDraft(settings.explainLang);
    setOpen(nextOpen);
  };

  const handleSave = () => {
    setSettings(settingsSchema.parse({ ...settings, explainLang: draft }));
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={EXPLANATION_DIALOG_TITLE} disabled={!hydrated} />}
      >
        <MessageSquareTextIcon />
      </DialogTrigger>
      <DialogContent aria-label={EXPLANATION_DIALOG_TITLE}>
        <DialogHeader>
          <DialogTitle>{EXPLANATION_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>
            Choose the language for translations and Pick up meanings. Messages already in this language are not
            translated. Saving regenerates the translations and Pick ups for the messages currently shown.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={EXPLANATION_SELECT_ID}>{EXPLANATION_DIALOG_TITLE}</Label>
          <select
            id={EXPLANATION_SELECT_ID}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
            value={draft}
            onChange={(e) => setDraft(languageSchema.parse(e.target.value))}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {LANGUAGE_DISPLAY_NAMES[lang]}
              </option>
            ))}
          </select>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
