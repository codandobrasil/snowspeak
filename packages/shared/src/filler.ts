// Interjeições de quem está ouvindo ("hmm", "uh-huh", "claro", "sim"): não são falas a mostrar nem a responder.
const FILLER_WORDS = new Set([
  "yeah", "yes", "yep", "yup", "ya", "sure", "okay", "ok", "right", "alright", "cool", "great", "nice",
  "exactly", "totally", "absolutely", "indeed", "gotcha", "wow", "oh", "ah", "uh", "um", "hmm", "mhm",
  "sim", "claro", "tá", "ta", "beleza", "certo", "entendi", "aham", "uhum", "perfeito", "isso", "legal", "show", "é", "né", "hum",
]);

const FILLER_PHRASES = [
  "that makes sense", "makes sense", "sounds good", "i got it", "got it", "i see", "of course", "no problem", "all right",
  "pois é", "tudo bem", "tá bom", "ta bom", "com certeza",
];

// Sons esticados: "hummmm", "hurrummm", "uhhh", "mmmm", "uh-huh", "mhm", "aham".
const FILLER_SOUND = /^(h+m+|h+u+m+|h+u+r+u+m+|u+m+|u+h+|m+|m+h+m+|a+h+|o+h+|e+h+|e+r+m*|u+h+-?h+u+h+|a+h+a+m+|u+h+u+m+)$/;

const MAX_FILLER_WORDS = 6;

/** A fala inteira é só interjeição (uma frase de verdade que começa com "yeah, so…" não é). */
export function isFillerOnly(text: string): boolean {
  let normalized = ` ${text.toLowerCase().replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim()} `;
  if (!normalized.trim()) return false;
  for (const phrase of FILLER_PHRASES) normalized = normalized.replace(new RegExp(`(?<= )${phrase}(?= )`, "g"), " ");
  const words = normalized.trim().split(" ").filter(Boolean);
  if (words.length > MAX_FILLER_WORDS) return false;
  return words.every((word) => FILLER_WORDS.has(word) || FILLER_SOUND.test(word));
}
