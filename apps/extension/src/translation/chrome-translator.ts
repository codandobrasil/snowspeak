import type { SentenceTranslator } from "../offscreen/translation-queue";

// Translator API do Chrome (estável desde o 138): tradução no próprio computador, sem cobrança por tradução.
export const TRANSLATION_LANGUAGES = { sourceLanguage: "en", targetLanguage: "pt" } as const;

type Availability = "unavailable" | "downloadable" | "downloading" | "available";

interface ChromeTranslator {
  translate(input: string): Promise<string>;
  destroy(): void;
}

interface ChromeTranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    signal?: AbortSignal;
    monitor?: (monitor: EventTarget) => void;
  }): Promise<ChromeTranslator>;
}

function translatorFactory(): ChromeTranslatorFactory | null {
  return (globalThis as { Translator?: ChromeTranslatorFactory }).Translator ?? null;
}

/** No offscreen: usa o modelo já baixado (não exige clique do usuário). */
export async function createChromeTranslator(): Promise<SentenceTranslator> {
  const factory = translatorFactory();
  if (!factory) throw new Error("Translator API indisponível neste navegador");
  const translator = await factory.create({ ...TRANSLATION_LANGUAGES });
  return { translate: (text) => translator.translate(text), destroy: () => translator.destroy() };
}

export type TranslatorPreparation = "ready" | "unavailable" | "cancelled";

/**
 * No painel, dentro do clique de Iniciar: baixa o modelo na primeira vez (exige gesto do usuário).
 * `signal` cancela o download.
 */
export async function prepareChromeTranslator(onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<TranslatorPreparation> {
  const factory = translatorFactory();
  if (!factory) return "unavailable";
  if (signal?.aborted) return "cancelled";
  try {
    if ((await factory.availability({ ...TRANSLATION_LANGUAGES })) === "unavailable") return "unavailable";
    const translator = await factory.create({
      ...TRANSLATION_LANGUAGES,
      ...(signal ? { signal } : {}),
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => onProgress((event as Event & { loaded: number }).loaded));
      },
    });
    translator.destroy();
    return "ready";
  } catch {
    return signal?.aborted ? "cancelled" : "unavailable";
  }
}
