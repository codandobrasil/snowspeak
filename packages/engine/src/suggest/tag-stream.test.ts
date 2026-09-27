import { describe, expect, it } from "vitest";
import { TagStreamParser } from "./tag-stream";

const RAW = "<en>Sure, I led that project.</en><pt>Claro, eu liderei esse projeto.</pt>";

function feed(chunks: string[]) {
  const parser = new TagStreamParser();
  const deltas = chunks.flatMap((c) => parser.push(c));
  return { parser, deltas };
}

describe("TagStreamParser", () => {
  it("separa inglês e português de uma resposta inteira", () => {
    const { parser } = feed([RAW]);
    expect(parser.result()).toEqual({ en: "Sure, I led that project.", pt: "Claro, eu liderei esse projeto." });
  });

  it("dá o mesmo resultado qualquer que seja o ponto de corte dos pedaços", () => {
    for (let cut = 1; cut < RAW.length; cut++) {
      const { parser, deltas } = feed([RAW.slice(0, cut), RAW.slice(cut)]);
      expect(parser.result()).toEqual({ en: "Sure, I led that project.", pt: "Claro, eu liderei esse projeto." });
      expect(deltas.filter((d) => d.lang === "en").map((d) => d.text).join("")).toBe("Sure, I led that project.");
    }
  });

  it("entrega o texto aos poucos, caractere a caractere", () => {
    const { deltas } = feed([...RAW]);
    expect(deltas.filter((d) => d.lang === "pt").map((d) => d.text).join("")).toBe("Claro, eu liderei esse projeto.");
  });

  it("ignora texto fora das tags e mantém '<' que não é tag", () => {
    const { parser } = feed(["Here you go:\n<en>Costs < 5 dollars.</en>\n<pt>Custa < 5 dólares.</pt> done"]);
    expect(parser.result()).toEqual({ en: "Costs < 5 dollars.", pt: "Custa < 5 dólares." });
  });

  it("resultado vazio quando o modelo não usa as tags", () => {
    expect(feed(["Sure, I led that project."]).parser.result()).toEqual({ en: "", pt: "" });
  });
  it("bloco que não fecha não conta como resposta completa", () => {
    expect(feed(["<en>Hi there.</en><pt>Olá, tudo"]).parser.result()).toEqual({ en: "Hi there.", pt: "" });
    expect(feed(["<en>Hi <pt>Olá</pt>"]).parser.result()).toEqual({ en: "", pt: "" });
  });
});
