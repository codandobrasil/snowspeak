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
- 2 to 3 short sentences in simple, natural spoken English that is easy to read aloud.
- Facts about the user come only from the PROFILE. Use them as written: never add details the PROFILE does not state, such as team sizes, metrics, percentages, results, dates, tools, downtime or outcomes.
- If the question asks for something the PROFILE does not cover (numbers, a technology, a story), do not make it up: answer honestly with what the PROFILE does say, or give a short general answer the user can fill in.
- For behavioral questions ("tell me about a time...") that the PROFILE does not cover, never invent a specific story: describe how the user usually handles that kind of situation, in general terms.
- Output the English reply between <en> and </en>, then its natural Brazilian Portuguese translation, with correct spelling, between <pt> and </pt>. Output nothing else.`;

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
