import type { Channel, Mode } from "@snowspeak/shared";

export const TRANSCRIPT_LINES = 20;

export interface TranscriptLine {
  channel: Channel;
  text: string;
}

export interface SuggestionContext {
  mode: Mode;
  context: string;
  profile: string;
  job: string;
  transcript: TranscriptLine[];
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const MODE_GUIDANCE: Record<Mode, string> = {
  interview:
    "The user is a candidate in a job interview. Answer as a confident, honest candidate: highlight relevant experience from the profile and connect it to the job.",
  work: "The user is in a work meeting with colleagues. Be clear, collaborative and professional.",
  sales: "The user is in a sales or customer call. Be helpful and persuasive without being pushy; move the conversation toward the next step.",
  relationship: "The user is in a personal, friendly conversation. Be warm, natural and genuine.",
};

const SYSTEM_RULES = `You help a Brazilian user reply in real time during a live English conversation.
Write the reply the user should say next, in the first person, answering the other person's last question or point.
Rules:
- 2 to 4 short sentences in simple, natural spoken English that is easy to read aloud.
- Ground the reply in the PROFILE when it is relevant. Never invent employers, numbers or facts that are not in the PROFILE; if something is missing, stay general.
- Output exactly <en>REPLY</en><pt>TRADUCAO</pt>, where TRADUCAO is the Brazilian Portuguese translation of REPLY. Output nothing else.`;

export function buildSuggestionMessages(ctx: SuggestionContext): ChatMessage[] {
  const sections: string[] = [];
  if (ctx.profile.trim()) sections.push(`PROFILE:\n${ctx.profile.trim()}`);
  if (ctx.job.trim()) sections.push(`JOB:\n${ctx.job.trim()}`);
  if (ctx.context.trim()) sections.push(`CONTEXT:\n${ctx.context.trim()}`);
  const conversation = ctx.transcript
    .slice(-TRANSCRIPT_LINES)
    .map((line) => `${line.channel === "them" ? "THEM" : "ME"}: ${line.text}`)
    .join("\n");
  sections.push(`CONVERSATION (most recent last):\n${conversation || "(nothing yet)"}`);
  sections.push("Write the suggested reply now.");
  return [
    { role: "system", content: `${SYSTEM_RULES}\n\n${MODE_GUIDANCE[ctx.mode]}` },
    { role: "user", content: sections.join("\n\n") },
  ];
}
