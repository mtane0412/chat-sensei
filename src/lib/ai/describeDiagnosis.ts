/**
 * `EnvironmentDiagnosis`(環境診断結果)を、設定画面にそのまま表示できる
 * 日本語メッセージと重大度のリストに変換する純関数。
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
      message: `Chrome ${diagnosis.chromeVersion} を検出しました(Prompt API 対応)。`,
    };
  }
  if (diagnosis.chromeVersion === null) {
    return {
      id: "chrome-version",
      level: "error",
      message: `Chrome を検出できませんでした。Prompt API は Chrome ${MINIMUM_CHROME_VERSION} 以降でのみ動作します。`,
    };
  }
  return {
    id: "chrome-version",
    level: "error",
    message: `Chrome ${diagnosis.chromeVersion} を検出しましたが、Prompt API には Chrome ${MINIMUM_CHROME_VERSION} 以降が必要です。Chrome を最新版に更新してください。`,
  };
}

function describeLanguageModel(diagnosis: EnvironmentDiagnosis): DiagnosisMessage {
  if (!diagnosis.languageModel.supported) {
    return {
      id: "language-model",
      level: "error",
      message: "この環境では Prompt API (window.LanguageModel) が見つかりません。翻訳・Pick up の生成は無効化されます。",
    };
  }

  switch (diagnosis.languageModel.availability) {
    case "available":
      return { id: "language-model", level: "ok", message: "Prompt API はすぐに利用できます。" };
    case "downloadable":
      return {
        id: "language-model",
        level: "warning",
        message: "Prompt API はモデルのダウンロードが必要です。次の操作でダウンロードを開始します。",
      };
    case "downloading":
      return { id: "language-model", level: "warning", message: "Prompt API のモデルをダウンロード中です。" };
    case "unavailable":
    default:
      return {
        id: "language-model",
        level: "error",
        message: "この端末・環境では Prompt API を利用できません(非対応OS、または空き容量不足の可能性があります)。",
      };
  }
}

function describeLanguageDetector(diagnosis: EnvironmentDiagnosis): DiagnosisMessage {
  if (!diagnosis.languageDetector.supported || diagnosis.languageDetector.availability === "unavailable") {
    return {
      id: "language-detector",
      level: "warning",
      message: "Language Detector API が利用できません。自動言語判定は無効化されますが、他の機能には影響しません。",
    };
  }
  return {
    id: "language-detector",
    level: "ok",
    message: "Language Detector API は利用可能です。",
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
      message: "このサイト用のストレージ割り当てを取得できませんでした。",
    };
  }
  const quotaGb = (quota / BYTES_PER_GB).toFixed(1);
  return {
    id: "storage",
    level: "ok",
    message: `このサイト用のストレージ割り当ては約${quotaGb}GBです(参考値)。これは Prompt API のモデルダウンロードに必要な OS 側の空き容量${MINIMUM_STORAGE_GB}GBとは別の指標のため、ダウンロードに失敗する場合は OS のストレージ空き容量をご確認ください。`,
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
