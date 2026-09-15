/**
 * Session title generation helpers. The fast model is asked for a title; its
 * reply is only used when it actually looks like one. Reasoning or an echo of
 * the instructions ("We need answer only title max 6 words...") is rejected
 * so the caller falls back to the truncated first message.
 */

export const TITLE_MAX_CHARS = 60;
const TITLE_MAX_WORDS = 10;

export const TITLE_SYSTEM_PROMPT =
  "You name chat conversations. Reply with a short title for the conversation that starts with the user's message: " +
  "at most 6 words (about 15 characters for Chinese or Japanese), in the same language as the message. " +
  "Output only the title itself — no quotes, no label, no explanation, no trailing punctuation.";

export function buildTitleUserPrompt(message: string): string {
  return message.slice(0, 500);
}

/**
 * Title built from the message itself. Used when the model's attempt is
 * rejected, so it has to read like a title rather than a truncated sentence:
 * first line, cut at a word boundary, no trailing punctuation.
 */
export function fallbackTitle(message: string): string {
  const firstLine = message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || message.trim();
  const clean = firstLine.replace(/\s+/g, " ");
  if (clean.length <= TITLE_MAX_CHARS) return clean.replace(/[.。!！?？,，;；:：]+$/, "");
  const cut = clean.slice(0, TITLE_MAX_CHARS);
  // CJK has no spaces to cut on; a hard cut is the best available boundary.
  const boundary = cut.lastIndexOf(" ");
  const trimmed = boundary > TITLE_MAX_CHARS * 0.5 ? cut.slice(0, boundary) : cut;
  return trimmed.replace(/[.。!！?？,，;；:：]+$/, "").trim();
}

/** Openers and phrases that mark reasoning or instruction echo, not a title. */
const NOT_A_TITLE = [
  /^(we|i|let me|let's|okay|ok|alright|hmm+|well|need to|we need|i need|the user|user)\b/i,
  /\b(max(imum)?\s*\d+\s*words?|\d+\s*words?\s*max|return only|no quotes|no punctuation|trailing punctuation|chat conversation|the user('s)?|user (wants|is asking|asked))\b/i,
  /^(用户|我需要|我们需要|我要|好的|首先|嗯|让我)/,
  /(不超过\s*\d+\s*个?(词|字)|只返回|只输出)/,
];

const WRAPPING_QUOTES = /^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/g;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * The prompt asks for the message's language and the fast model often ignores
 * it: two of three English conversations came back with a Chinese title. A
 * title may not introduce a script the message never used. The reverse is not
 * checked — a Chinese message naming an English tool legitimately produces a
 * Latin title.
 */
export function titleMatchesMessageScript(title: string, message: string): boolean {
  if (!message) return true;
  return CJK.test(message) || !CJK.test(title);
}

/**
 * Returns a cleaned title, or null when the model output is not a usable
 * title. Pass the source message to also reject a title in the wrong script.
 */
export function sanitizeGeneratedTitle(raw: string, message = ""): string | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Multi-line output is still refused: a trailing line is as often the
  // model's commentary ("This title captures the request") as the title, and
  // the fallback below is a good title in its own right.
  if (lines.length !== 1) return null;

  const title = lines[0]
    .replace(/^#+\s*/, "")
    .replace(/^(title|标题)\s*[:：]\s*/i, "")
    .replace(/^[*_]+|[*_]+$/g, "")
    .replace(WRAPPING_QUOTES, "")
    .replace(/[.。!！?？:：;；,，、]+$/, "")
    .replace(WRAPPING_QUOTES, "")
    .trim();

  if (!title) return null;
  if (NOT_A_TITLE.some((pattern) => pattern.test(title))) return null;
  // More than one sentence is prose, not a title.
  if (/[.。!！?？]\s*\S/.test(title)) return null;
  if (title.split(/\s+/).length > TITLE_MAX_WORDS) return null;
  if (!titleMatchesMessageScript(title, message)) return null;
  return title.slice(0, TITLE_MAX_CHARS);
}
