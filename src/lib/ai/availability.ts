/**
 * Chrome 内蔵AI(Prompt API / Language Detector API)の利用可否を診断するモジュール。
 *
 * chat-sensei はサーバーを持たないクライアントサイド専用アプリのため、
 * `window.LanguageModel` / `window.LanguageDetector` が使えない環境では
 * 暗黙のフォールバック(クラウドAPIへの切り替えやダミー解説)を行わず、
 * 利用者に理由を明示して機能を無効化する(CLAUDE.md の Fail-Fast 方針に準拠)。
 *
 * 診断ロジックは `diagnoseEnvironment` に依存性注入する形にまとめており、
 * ブラウザ組み込みAPIをモックしたテストで振る舞いを検証できる。
 */

/**
 * Prompt API / Language Detector API が共通して返す可用性ステータス。
 * `@types/dom-chromium-ai` がグローバルに宣言する `Availability` 型をそのまま再利用し、
 * 独自定義との二重管理を避ける。
 */
export type ApiAvailability = Availability;

/**
 * Web ページ向けに Prompt API が origin trial トークンなしで stable 動作する
 * 最小 Chrome メジャーバージョン。2026-07-28 時点の公式ドキュメントで確認済み。
 */
export const MINIMUM_CHROME_VERSION = 148;

/** 個々の組み込みAPIの診断結果 */
export interface ApiDiagnosis {
  /** `window` にAPI自体が存在するか(ブラウザ・バージョンによる対応可否) */
  supported: boolean;
  /** `availability()` の呼び出し結果。`supported` が false の場合は null。`availability()` 自体が失敗した場合は "unavailable" */
  availability: ApiAvailability | null;
  /**
   * `availability()` の呼び出しが例外・reject で失敗した場合の理由。
   * Chrome 側で API が無効化されていると `undefined` で reject することがあり(Chrome 152 で確認)、
   * 診断全体を失敗させる代わりに、その API だけを理由付きで利用不可として報告する
   */
  error?: string;
}

/** ストレージ空き容量の概算(バイト単位)。取得できない場合は null */
export interface StorageEstimate {
  quota: number | null;
  usage: number | null;
}

/** 環境診断の結果全体 */
export interface EnvironmentDiagnosis {
  chromeVersion: number | null;
  meetsMinimumChromeVersion: boolean;
  languageModel: ApiDiagnosis;
  languageDetector: ApiDiagnosis;
  storageEstimate: StorageEstimate;
  /**
   * Prompt API と Language Detector API の両方が、すぐに使えるかユーザー操作でダウンロードを開始できる状態か。
   * 翻訳・Pick up は発言ごとの言語判定(Language Detector)を前提にするため、どちらか一方では不十分とする
   */
  overallReady: boolean;
}

/** `diagnoseEnvironment` に渡す依存性。実ブラウザではグローバルオブジェクトから組み立てる */
export interface DiagnosisDeps {
  userAgent: string;
  /** 診断では常にオプション省略(デフォルト設定)で可用性を確認するため引数を取らない */
  languageModel?: { availability: () => Promise<ApiAvailability> };
  languageDetector?: { availability: () => Promise<ApiAvailability> };
  storage?: { estimate: () => Promise<{ quota?: number; usage?: number }> };
}

/**
 * User-Agent 文字列から Chrome のメジャーバージョンを抽出する。
 * Chrome を含まない(あるいは Chromium ベースでない) User-Agent の場合は null を返す。
 */
export function parseChromeMajorVersion(userAgent: string): number | null {
  const match = userAgent.match(/Chrome\/(\d+)\./);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * 検出した Chrome メジャーバージョンが Prompt API の最小要件を満たすか判定する。
 * バージョンが取得できない(null)場合は非対応として扱う。
 */
export function isChromeVersionSupported(version: number | null): boolean {
  if (version === null) {
    return false;
  }
  return version >= MINIMUM_CHROME_VERSION;
}

/** `availability` の結果を「すぐ使える、または利用者操作でDL開始できる」かどうかに変換する */
function isUsableAvailability(availability: ApiAvailability | null): boolean {
  return availability === "available" || availability === "downloadable";
}

/**
 * 1 つの組み込み API の `availability()` を呼び、失敗した場合は理由付きの unavailable にする。
 * API が注入されていない(環境に存在しない)場合は未対応として扱う
 */
async function diagnoseApi(api: { availability: () => Promise<ApiAvailability> } | undefined): Promise<ApiDiagnosis> {
  if (!api) return { supported: false, availability: null };
  try {
    return { supported: true, availability: await api.availability() };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { supported: true, availability: "unavailable", error: `availability() rejected: ${reason}` };
  }
}

/**
 * 注入された依存性をもとにブラウザ環境を診断する。
 *
 * `languageModel` / `languageDetector` / `storage` を省略した場合は、
 * そのAPIが現在の環境に存在しないものとして扱う(呼び出し元でモック不要な非対応判定ができる)。
 */
export async function diagnoseEnvironment(deps: DiagnosisDeps): Promise<EnvironmentDiagnosis> {
  const chromeVersion = parseChromeMajorVersion(deps.userAgent);

  const languageModel = await diagnoseApi(deps.languageModel);
  const languageDetector = await diagnoseApi(deps.languageDetector);

  let storageEstimate: StorageEstimate = { quota: null, usage: null };
  if (deps.storage) {
    const estimate = await deps.storage.estimate();
    storageEstimate = {
      quota: estimate.quota ?? null,
      usage: estimate.usage ?? null,
    };
  }

  return {
    chromeVersion,
    meetsMinimumChromeVersion: isChromeVersionSupported(chromeVersion),
    languageModel,
    languageDetector,
    storageEstimate,
    overallReady:
      isUsableAvailability(languageModel.availability) && isUsableAvailability(languageDetector.availability),
  };
}
