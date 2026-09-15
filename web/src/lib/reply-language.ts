/**
 * Explicit reply language for the agent.
 *
 * A general "reply in the user's language" rule was not enough on
 * lab.cloudmol.org: replaying the IL-13 session that answered an English request
 * in Chinese, openai/gpt-5.6-luna still answered in Chinese in 2 to 10 of 12
 * runs with that rule, and in 8 of 12 even with every Chinese character removed
 * from the prompt. Naming the language of the user's latest message ("The
 * user's latest message is written in English. Write your reply in English.")
 * gave English in 12 of 12. The server therefore detects the language and states
 * it at the end of the system prompt.
 */

export type ReplyLanguage = "Chinese" | "Japanese" | "Korean" | "English";

const STRUCTURE_SELECTION_BLOCK = /<structure_selection>[\s\S]*?<\/structure_selection>/g;

/** Function words that mark Latin-script text as English. */
const ENGLISH_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "with", "without", "to", "of", "in", "on", "at", "by", "from", "into",
  "using", "use", "is", "are", "was", "be", "it", "this", "that", "these", "my", "me", "i", "you", "your", "we",
  "please", "can", "could", "would", "should", "how", "what", "why", "which", "when", "where", "who", "do", "does",
  "not", "all", "any", "some", "then", "than", "as", "if", "about", "run", "design", "predict", "find", "show",
  "make", "analyze", "compare", "download", "search", "give", "tell", "help",
]);

/** Remove context the client appends to a message (Mol* selection) so it cannot decide the language. */
export function stripInjectedContext(text: string): string {
  return text.replace(STRUCTURE_SELECTION_BLOCK, " ").trim();
}

/**
 * Latin words that carry language, with the ones that do not removed first:
 * paths, file names, tool names and accessions are written the same way in
 * every language, and counting them let a Chinese request full of them read
 * as English.
 */
function languageBearingWords(sample: string): string[] {
  const withoutIdentifiers = sample
    .replace(/\S*[\\/]\S*/g, " ")
    .replace(/\b[A-Za-z0-9]+\.[A-Za-z0-9.]+\b/g, " ")
    .replace(/\b\w*[_\d]\w*\b/g, " ");
  return (withoutIdentifiers.match(/[A-Za-z]+/g) || []).map((word) => word.toLowerCase());
}

/** Language of a user-authored message, or null when it cannot be told reliably. */
export function detectReplyLanguage(text: string): ReplyLanguage | null {
  const sample = stripInjectedContext(text || "");
  const hangul = (sample.match(/[가-힯]/g) || []).length;
  const kana = (sample.match(/[぀-ヿ]/g) || []).length;
  const han = (sample.match(/[㐀-䶿一-鿿]/g) || []).length;
  // Identifier-only input ("1CRN?") still counts as Latin script for the
  // short-input rule below, even though it carries no language.
  const latinTokens = (sample.match(/[A-Za-z]+/g) || []);
  const latinWords = languageBearingWords(sample);

  // One CJK character carries about as much as one English word: tool names,
  // IDs and file names inside a Chinese request do not make it English.
  if (hangul > 0 && hangul >= latinWords.length) return "Korean";
  if (kana > 0 && kana + han >= latinWords.length) return "Japanese";
  if (han > 0 && han >= latinWords.length) return "Chinese";
  if (latinTokens.length === 0) return null;
  if (latinWords.some((word) => ENGLISH_WORDS.has(word)) || latinTokens.length <= 3) return "English";
  return null;
}

type TranscriptEntry = { role?: string; content?: unknown; hidden?: boolean };

/**
 * Text whose language decides the reply: the latest message the user actually
 * wrote. Internal follow-ups (hidden messages such as WeMol job completion)
 * inherit the language of the conversation instead of their own English text.
 */
export function languageSample(messages: TranscriptEntry[], fallback: string): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry.role === "user" && !entry.hidden && typeof entry.content === "string" && entry.content.trim()) {
      return entry.content;
    }
  }
  return fallback;
}

/** System-prompt section stating the reply language. */
export function buildReplyLanguageSection(language: ReplyLanguage | null): string {
  if (!language) {
    return "\n\n## Response Language\nWrite your reply in the same language as the user's latest message, whatever language the rest of this prompt, the tool outputs or earlier turns use.";
  }
  return `\n\n## Response Language\nThe user's latest message is written in ${language}. Write your reply in ${language}.`;
}
