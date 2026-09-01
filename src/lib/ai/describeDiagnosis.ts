/**
 * `EnvironmentDiagnosis`(環境診断結果)を、設定画面にそのまま表示できる
 * 英語メッセージ(UI は言語学習用途のため英語で統一)と重大度のリストに変換する純関数。
 *
 * chat-sensei は「AIが使えない環境ではクラウドAPIに切り替える」といった
 * 暗黙のフォールバックを行わないため(CLAUDE.md の Fail-Fast 方針)、
 * 利用できない場合は理由を利用者にそのまま伝えることを目的とする。
 */
import { MINIMUM_CHROME_VERSION, type EnvironmentDiagnosis } from "./availability";

/** Prompt API がモデルダウンロードに要求する OS 側の最小空き容量(GB、公式ドキュメント記載値) */
const MINIMUM_STORAGE_GB = 22;

const BYTES_PER_GB = 1024 * 1024 * 1024;

export type DiagnosisMessageLevel = "ok" | "warning" | "error";

export interface DiagnosisMessage {
  id: "chrome-version" | "language-model" | "language-detector" | "storage";
  level: DiagnosisMessageLevel;
  message: string;
}

function describeChromeVersion(diagnosis: EnvironmentDiagnosis): DiagnosisMessage {
  if (diagnosis.meetsMinimumChromeVersion) {
    return {
      id: "chrome-version",
      level: "ok",
      message: `Detected Chrome ${diagnosis.chromeVersion} (supports the Prompt API).`,
    };
  }
  if (diagnosis.chromeVersion === null) {
    return {
      id: "chrome-version",
      level: "error",
      message: `Chrome was not detected. The Prompt API only works in Chrome ${MINIMUM_CHROME_VERSION} or later.`,
    };
  }
  return {
    id: "chrome-version",
    level: "error",
    message: `Detected Chrome ${diagnosis.chromeVersion}, but the Prompt API requires Chrome ${MINIMUM_CHROME_VERSION} or later. Please update Chrome.`,
  };
}

function describeLanguageModel(diagnosis: EnvironmentDiagnosis): DiagnosisMessage {
  if (!diagnosis.languageModel.supported) {
    return {
      id: "language-model",
      level: "error",
      message: "The Prompt API (window.LanguageModel) was not found in this environment. Translation and Pick up are disabled.",
    };
  }

  switch (diagnosis.languageModel.availability) {
    case "available":
      return { id: "language-model", level: "ok", message: "The Prompt API is ready to use." };
    case "downloadable":
      return {
        id: "language-model",
        level: "warning",
        message: "The Prompt API needs to download its model. The download starts on your next action.",
      };
    case "downloading":
      return { id: "language-model", level: "warning", message: "The Prompt API model is downloading." };
    case "unavailable":
    default:
      return {
        id: "language-model",
        level: "error",
        message: "The Prompt API is not available on this device (unsupported OS or not enough free disk space).",
      };
  }
}

function describeLanguageDetector(diagnosis: EnvironmentDiagnosis): DiagnosisMessage {
  if (!diagnosis.languageDetector.supported || diagnosis.languageDetector.availability === "unavailable") {
    return {
      id: "language-detector",
      level: "warning",
      message: "The Language Detector API is not available. Automatic language detection is disabled; other features are unaffected.",
    };
  }
  return {
    id: "language-detector",
    level: "ok",
    message: "The Language Detector API is available.",
  };
}

/**
 * `navigator.storage.estimate()` の `quota` は「このサイト専用のストレージ割り当て」であり、
 * Prompt API のモデル(ブラウザ全体で共有される)のダウンロードに必要な
 * 「OSの空き容量22GB」とは異なる指標である。実測(Chrome 150, macOS)では
 * quota が約10GBのオリジンでも Prompt API の availability は "available" だった。
 * ブラウザからOSの実際の空き容量を取得するAPIは存在しないため、
 * ここでは quota を参考値として提示するに留め、22GB要件と混同させないよう明示的に区別する。
 */
function describeStorage(diagnosis: EnvironmentDiagnosis): DiagnosisMessage {
  const { quota } = diagnosis.storageEstimate;
  if (quota === null) {
    return {
      id: "storage",
      level: "warning",
      message: "Could not read the storage quota for this site.",
    };
  }
  const quotaGb = (quota / BYTES_PER_GB).toFixed(1);
  return {
    id: "storage",
    level: "ok",
    message: `The storage quota for this site is about ${quotaGb}GB (for reference). This is separate from the ${MINIMUM_STORAGE_GB}GB of free OS disk space the Prompt API model download requires, so if the download fails, check your OS free disk space.`,
  };
}

/** 環境診断結果を、設定画面に表示するメッセージ一覧に変換する */
export function describeDiagnosis(diagnosis: EnvironmentDiagnosis): DiagnosisMessage[] {
  return [
    describeChromeVersion(diagnosis),
    describeLanguageModel(diagnosis),
    describeLanguageDetector(diagnosis),
    describeStorage(diagnosis),
  ];
}
