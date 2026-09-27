import { describe, expect, it } from "vitest";
import { TRANSCRIPT_LINES, buildSuggestionMessages, type SuggestionContext } from "./prompt";

const base: SuggestionContext = {
  mode: "interview",
  context: "Entrevista na Acme",
  profile: "Backend developer, 8 years, Node and Kafka at Nubank.",
  job: "Senior Backend Engineer, payments.",
  responseLength: "medium",
  transcript: [
    { channel: "them", text: "Tell me about yourself." },
    { channel: "me", text: "Sure." },
  ],
};

describe("buildSuggestionMessages", () => {
  it("o tamanho escolhido muda quantas frases a resposta tem", () => {
    const system = (responseLength: SuggestionContext["responseLength"]) => buildSuggestionMessages({ ...base, responseLength })[0]?.content ?? "";
    expect(system("short")).toContain("exactly 1 short sentence");
    expect(system("short")).not.toContain("2 to 3");
    expect(system("medium")).toContain("2 to 3 short sentences");
    expect(system("long")).toContain("4 to 6 sentences");
    expect(system("long")).toContain("concrete example");
  });

  it("instrui formato, tamanho e modo no system", () => {
    const [system] = buildSuggestionMessages(base);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("<en>");
    expect(system?.content).toContain("<pt>");
    expect(system?.content).toContain("2 to 3");
    expect(system?.content.toLowerCase()).toContain("job interview");
  });

  it("proíbe inventar fatos e histórias que o currículo não traz", () => {
    const system = buildSuggestionMessages(base)[0]?.content ?? "";
    expect(system).toContain("never add details the PROFILE does not state");
    expect(system).toContain("never invent a specific story");
  });

  it("não usa marcadores que o modelo possa copiar literalmente", () => {
    const system = buildSuggestionMessages(base)[0]?.content ?? "";
    expect(system).not.toMatch(/REPLY|TRADUCAO/);
  });

  it("inclui currículo, vaga, contexto e a conversa rotulada", () => {
    const user = buildSuggestionMessages(base)[1]?.content ?? "";
    expect(user).toContain("Nubank");
    expect(user).toContain("Senior Backend Engineer");
    expect(user).toContain("Entrevista na Acme");
    expect(user).toContain("THEM: Tell me about yourself.\nME: Sure.");
  });

  it("omite seções vazias", () => {
    const user = buildSuggestionMessages({ ...base, profile: "", job: "", context: "" })[1]?.content ?? "";
    expect(user).not.toContain("PROFILE");
    expect(user).not.toContain("JOB");
    expect(user).not.toContain("CONTEXT");
  });

  it("usa só as últimas falas", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => ({ channel: "them" as const, text: `line ${i}` }));
    const user = buildSuggestionMessages({ ...base, transcript })[1]?.content ?? "";
    expect(user).not.toContain("line 9\n");
    expect(user).toContain(`line ${30 - TRANSCRIPT_LINES}`);
    expect(user).toContain("line 29");
  });

  it("destaca a pergunta escolhida pelo usuário", () => {
    const [system, user] = buildSuggestionMessages({ ...base, question: "Why do you want to work here?" });
    expect(user?.content).toContain("QUESTION TO ANSWER:\nWhy do you want to work here?");
    expect(system?.content).toContain("QUESTION TO ANSWER");
  });

  it("sem pergunta escolhida, não há a seção", () => {
    expect(buildSuggestionMessages(base)[1]?.content).not.toContain("QUESTION TO ANSWER:");
  });

  it("muda a orientação conforme o modo", () => {
    const sales = buildSuggestionMessages({ ...base, mode: "sales" })[0]?.content ?? "";
    expect(sales.toLowerCase()).toContain("sales");
  });
});
