const QUESTION_STARTERS = [
  "what", "why", "how", "when", "where", "who", "which",
  "tell me", "tell us", "can you", "could you", "would you", "will you",
  "do you", "did you", "have you", "are you", "were you", "is there", "is it",
  "walk me through", "walk us through", "describe", "explain", "give me", "share",
];

function lastSentence(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/).filter((p) => p.trim().length > 0);
  return (parts[parts.length - 1] ?? "").trim();
}

/** Fala do participante que pede uma resposta: termina com "?" ou a última frase começa com expressão interrogativa. */
export function looksLikeQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.split(/\s+/).filter(Boolean).length < 3) return false;
  if (normalized.endsWith("?")) return true;
  const last = lastSentence(normalized).replace(/^(so|and|okay|ok|great|alright|well|now),?\s+/, "");
  return QUESTION_STARTERS.some((starter) => last.startsWith(`${starter} `));
}
