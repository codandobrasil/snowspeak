import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeTranslator, prepareChromeTranslator } from "./chrome-translator";

type Availability = "unavailable" | "downloadable" | "downloading" | "available";

function installFakeTranslator(options: { availability?: Availability; createError?: Error; progress?: number[]; hang?: boolean } = {}) {
  const created: Array<{ destroyed: boolean }> = [];
  const factory = {
    availability: vi.fn(async () => options.availability ?? "available"),
    create: vi.fn(async (createOptions: { monitor?: (monitor: EventTarget) => void; signal?: AbortSignal }) => {
      if (options.createError) throw options.createError;
      if (options.hang) {
        // Download que não termina: só o cancelamento encerra.
        await new Promise((_resolve, reject) =>
          createOptions.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
        );
      }
      const monitor = new EventTarget();
      createOptions.monitor?.(monitor);
      for (const loaded of options.progress ?? []) {
        monitor.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded }));
      }
      const translator = {
        destroyed: false,
        translate: async (text: string) => `pt:${text}`,
        destroy() {
          translator.destroyed = true;
        },
      };
      created.push(translator);
      return translator;
    }),
  };
  (globalThis as { Translator?: unknown }).Translator = factory;
  return { factory, created };
}

afterEach(() => {
  delete (globalThis as { Translator?: unknown }).Translator;
});

describe("createChromeTranslator", () => {
  it("cria o tradutor de inglês para português e traduz", async () => {
    const { factory } = installFakeTranslator();
    const translator = await createChromeTranslator();
    await expect(translator.translate("Hi.")).resolves.toBe("pt:Hi.");
    expect(factory.create).toHaveBeenCalledWith({ sourceLanguage: "en", targetLanguage: "pt" });
    translator.destroy();
  });

  it("falha quando o Chrome não tem a Translator API", async () => {
    await expect(createChromeTranslator()).rejects.toThrow();
  });

  it("falha quando o Chrome não consegue criar o tradutor", async () => {
    installFakeTranslator({ createError: new Error("NotSupportedError") });
    await expect(createChromeTranslator()).rejects.toThrow("NotSupportedError");
  });
});

describe("prepareChromeTranslator", () => {
  it("baixa o modelo, informa o progresso e libera o tradutor de teste", async () => {
    const { created } = installFakeTranslator({ availability: "downloadable", progress: [0, 0.5, 1] });
    const progress: number[] = [];
    await expect(prepareChromeTranslator((fraction) => progress.push(fraction))).resolves.toBe("ready");
    expect(progress).toEqual([0, 0.5, 1]);
    expect(created[0]?.destroyed).toBe(true);
  });

  it("indisponível quando o par de idiomas não é suportado", async () => {
    const { factory } = installFakeTranslator({ availability: "unavailable" });
    await expect(prepareChromeTranslator(() => {})).resolves.toBe("unavailable");
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("indisponível quando a criação falha ou a API não existe", async () => {
    installFakeTranslator({ createError: new Error("NotSupportedError") });
    await expect(prepareChromeTranslator(() => {})).resolves.toBe("unavailable");
    delete (globalThis as { Translator?: unknown }).Translator;
    await expect(prepareChromeTranslator(() => {})).resolves.toBe("unavailable");
  });
  it("cancela o download quando o usuário desiste", async () => {
    const { factory } = installFakeTranslator({ availability: "downloadable", hang: true });
    const controller = new AbortController();
    const preparation = prepareChromeTranslator(() => {}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(preparation).resolves.toBe("cancelled");
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it("não começa quando já foi cancelado", async () => {
    const { factory } = installFakeTranslator();
    const controller = new AbortController();
    controller.abort();
    await expect(prepareChromeTranslator(() => {}, controller.signal)).resolves.toBe("cancelled");
    expect(factory.create).not.toHaveBeenCalled();
  });
});
