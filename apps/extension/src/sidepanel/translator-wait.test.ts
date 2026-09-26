import { describe, expect, it } from "vitest";
import { waitForTranslator } from "./translator-wait";

describe("waitForTranslator", () => {
  it("devolve o resultado do preparo quando ele termina primeiro", async () => {
    await expect(waitForTranslator(Promise.resolve("ready"), new Promise(() => {}))).resolves.toBe("ready");
  });

  it("segue sem esperar quando o usuário escolhe continuar só em inglês", async () => {
    await expect(waitForTranslator(new Promise(() => {}), Promise.resolve())).resolves.toBe("skipped");
  });
});
