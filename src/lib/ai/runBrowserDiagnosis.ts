/**
 * 実行中のブラウザから Prompt API / Language Detector API の診断依存性を組み立て、
 * `diagnoseEnvironment`(純関数)に橋渡しする薄いラッパー。
 *
 * `window.LanguageModel` / `window.LanguageDetector` はブラウザによって
 * 定義されていない場合があるため、`typeof` で存在確認したうえで
 * 診断関数に渡す `DiagnosisDeps` を組み立てる。ここでは分岐のみを行い、
 * 判定ロジック自体は `diagnoseEnvironment` 側に委譲する。
 */
import { diagnoseEnvironment, type DiagnosisDeps, type EnvironmentDiagnosis } from "./availability";

/** 実行中の環境が `navigator.storage.estimate` を提供しているか判定する */
function getStorageDeps(): DiagnosisDeps["storage"] {
  if (typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function") {
    return undefined;
  }
  return { estimate: () => navigator.storage.estimate() };
}

/**
 * 現在のブラウザ環境を診断する。Chrome 内蔵AIが使えるかどうかを
 * 画面側から呼び出すためのエントリーポイント。
 */
export async function runBrowserDiagnosis(): Promise<EnvironmentDiagnosis> {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;

  const languageModel: DiagnosisDeps["languageModel"] =
    typeof LanguageModel === "undefined" ? undefined : { availability: () => LanguageModel.availability() };

  const languageDetector: DiagnosisDeps["languageDetector"] =
    typeof LanguageDetector === "undefined" ? undefined : { availability: () => LanguageDetector.availability() };

  return diagnoseEnvironment({
    userAgent,
    languageModel,
    languageDetector,
    storage: getStorageDeps(),
  });
}
