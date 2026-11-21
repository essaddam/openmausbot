const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from", "has", "have", "how", "i", "if", "in", "is", "it", "me", "my",
  "of", "on", "or", "so", "that", "the", "this", "to", "was", "we", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
  "au", "aux", "avec", "ce", "ces", "cette", "dans", "de", "des", "du", "elle", "en", "est", "et", "il", "je", "la", "le", "les", "leur", "lui", "ma",
  "mais", "me", "mes", "moi", "mon", "ne", "nous", "on", "ou", "par", "pas", "pour", "qu", "que", "qui", "sa", "se", "ses", "son", "sur", "ta", "te",
  "tes", "toi", "ton", "tu", "un", "une", "vos", "votre", "vous", "est-ce", "faire", "fais", "peux", "veux", "comment", "quoi", "quel", "quelle",
]);

export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clip(text: string, max: number): string {
  const flat = squash(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Content words of a query, folded, for full-text and entity matching. */
export function terms(text: string): string[] {
  const words = fold(text).match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !STOPWORDS.has(word)))];
}

export function entityKey(name: string): string {
  return fold(squash(name)).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:password|passwd|mot de passe|mdp|secret|token|api[_ -]?key)(?:\s+[\p{L}\p{N}_-]+){0,3}?\s*(?:[:=]|\bis\b|\best\b|c'est)\s*\S{6,}/iu,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** Whole-word match on folded text: "IST" is not in "dentist". */
export function mentionsWords(text: string, words: string): boolean {
  const wanted = terms(words);
  if (!wanted.length) return false;
  const present = new Set(fold(text).match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []);
  return wanted.every((word) => present.has(word));
}

const LOCATION = /https?:\/\/[^\s<>[\]()]+|(?:~\/|(?<![\p{L}\p{N}])\/[\p{L}_.]|[A-Za-z]:\\)[^\s<>[\](),;]*/gu;
const NUMBER = /\p{N}+(?:[.,:/-]\p{N}+)*%?/gu;
const tokens = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[0].toLowerCase().replace(/[.,:;!?'"]+$/u, ""));

/** Every number, path and URL a fact states must come from the quoted words it rests on. */
export function figuresSupported(fact: string, evidence: readonly string[]): boolean {
  const source = evidence.join("\n");
  return [NUMBER, LOCATION].every((pattern) => tokens(fact, pattern).every((value) => tokens(source, pattern).includes(value)));
}

export function quotedIn(quote: string, said: string): boolean {
  const needle = fold(squash(quote)).replace(/[«»“”"]/g, "");
  return needle.length >= 3 && fold(squash(said)).replace(/[«»“”"]/g, "").includes(needle);
}
