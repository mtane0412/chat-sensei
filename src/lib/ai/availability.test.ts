/**
 * src/lib/ai/availability.ts のテスト。
 *
 * Chrome バージョン判定とブラウザ環境診断(diagnoseEnvironment)を検証する。
 * LanguageModel / LanguageDetector はブラウザ組み込みAPIのため、
 * テストでは依存性注入した最小限のモックを渡して振る舞いを確認する。
 */
import { describe, expect, it } from "vitest";
import {
  MINIMUM_CHROME_VERSION,
  diagnoseEnvironment,
  isChromeVersionSupported,
  parseChromeMajorVersion,
} from "./availability";

describe("parseChromeMajorVersion", () => {
  it("Chrome の User-Agent からメジャーバージョンを抽出できる", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.187 Safari/537.36";
    expect(parseChromeMajorVersion(ua)).toBe(150);
  });

  it("Chrome Canary のような3桁バージョンでも抽出できる", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7772.0 Safari/537.36";
    expect(parseChromeMajorVersion(ua)).toBe(148);
  });

  it("Chrome を含まない User-Agent では null を返す", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    expect(parseChromeMajorVersion(ua)).toBeNull();
  });
});

describe("isChromeVersionSupported", () => {
  it("null の場合は非対応と判定する", () => {
    expect(isChromeVersionSupported(null)).toBe(false);
  });

  it(`${MINIMUM_CHROME_VERSION} 未満は非対応と判定する`, () => {
    expect(isChromeVersionSupported(MINIMUM_CHROME_VERSION - 1)).toBe(false);
  });

  it(`${MINIMUM_CHROME_VERSION} 以上は対応と判定する`, () => {
    expect(isChromeVersionSupported(MINIMUM_CHROME_VERSION)).toBe(true);
    expect(isChromeVersionSupported(MINIMUM_CHROME_VERSION + 10)).toBe(true);
  });
});

describe("diagnoseEnvironment", () => {
  const chromeUa =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.187 Safari/537.36";

  it("LanguageModel/LanguageDetector が存在しない環境では未対応として報告する", async () => {
    const result = await diagnoseEnvironment({ userAgent: chromeUa });

    expect(result.chromeVersion).toBe(150);
    expect(result.meetsMinimumChromeVersion).toBe(true);
    expect(result.languageModel).toEqual({ supported: false, availability: null });
    expect(result.languageDetector).toEqual({ supported: false, availability: null });
    expect(result.overallReady).toBe(false);
  });

  it("LanguageModel と LanguageDetector の両方が 'available' を返す場合は利用可能と判定する", async () => {
    const result = await diagnoseEnvironment({
      userAgent: chromeUa,
      languageModel: { availability: async () => "available" },
      languageDetector: { availability: async () => "available" },
    });

    expect(result.languageModel).toEqual({ supported: true, availability: "available" });
    expect(result.overallReady).toBe(true);
  });

  it("両方が 'downloadable' の場合も利用可能扱いにする(初回DLで開始できるため)", async () => {
    const result = await diagnoseEnvironment({
      userAgent: chromeUa,
      languageModel: { availability: async () => "downloadable" },
      languageDetector: { availability: async () => "downloadable" },
    });

    expect(result.overallReady).toBe(true);
  });

  it("LanguageModel.availability() が 'unavailable' の場合は利用不可と判定する", async () => {
    const result = await diagnoseEnvironment({
      userAgent: chromeUa,
      languageModel: { availability: async () => "unavailable" },
      languageDetector: { availability: async () => "available" },
    });

    expect(result.overallReady).toBe(false);
  });

  it("LanguageModel が使えても LanguageDetector が無い場合は利用不可と判定する(発言ごとの言語判定に必須のため)", async () => {
    const result = await diagnoseEnvironment({
      userAgent: chromeUa,
      languageModel: { availability: async () => "available" },
    });

    expect(result.overallReady).toBe(false);
  });

  it("LanguageDetector.availability() が 'unavailable' の場合は利用不可と判定する", async () => {
    const result = await diagnoseEnvironment({
      userAgent: chromeUa,
      languageModel: { availability: async () => "available" },
      languageDetector: { availability: async () => "unavailable" },
    });

    expect(result.overallReady).toBe(false);
  });

  it("availability() が reject した API は、その理由を添えて unavailable として扱い、診断全体は失敗させない(Chrome 側で API が無効化されている場合など)", async () => {
    const result = await diagnoseEnvironment({
      userAgent: chromeUa,
      languageModel: { availability: async () => "available" },
      // Chrome 152 で Language Detector API が無効化されているとき、実際に undefined で reject する
      languageDetector: { availability: () => Promise.reject(undefined) },
    });

    expect(result.languageModel).toEqual({ supported: true, availability: "available" });
    expect(result.languageDetector).toEqual({
      supported: true,
      availability: "unavailable",
      error: "availability() rejected: undefined",
    });
    expect(result.overallReady).toBe(false);
  });

  it("navigator.storage.estimate() の結果を quota/usage として反映する", async () => {
    const result = await diagnoseEnvironment({
      userAgent: chromeUa,
      storage: { estimate: async () => ({ quota: 100_000, usage: 40_000 }) },
    });

    expect(result.storageEstimate).toEqual({ quota: 100_000, usage: 40_000 });
  });

  it("storage.estimate が利用できない場合は null のまま例外を投げない", async () => {
    const result = await diagnoseEnvironment({ userAgent: chromeUa });

    expect(result.storageEstimate).toEqual({ quota: null, usage: null });
  });

  it("LanguageDetector も同様に可用性を反映する", async () => {
    const result = await diagnoseEnvironment({
      userAgent: chromeUa,
      languageDetector: { availability: async () => "downloading" },
    });

    expect(result.languageDetector).toEqual({ supported: true, availability: "downloading" });
  });
});
