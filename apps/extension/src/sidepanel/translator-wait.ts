import type { TranslatorPreparation } from "../translation/chrome-translator";

export type TranslatorWaitOutcome = TranslatorPreparation | "skipped";

/** Espera o preparo do tradutor, ou segue quando o usuário escolhe continuar só em inglês. */
export function waitForTranslator(preparation: Promise<TranslatorPreparation>, skipped: Promise<void>): Promise<TranslatorWaitOutcome> {
  return Promise.race([preparation, skipped.then(() => "skipped" as const)]);
}
