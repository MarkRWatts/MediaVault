// Corrects the "Every Word Capitalized" casing that album titles come in
// from ingestion (e.g. "Best Of Bowie", "The Cross Of Changes") into proper
// title case by lowercasing minor words when they're not the first or last
// word — never touching letter-casing otherwise, so stylized titles like
// "HIStory" or acronyms like "R.E.M." pass through untouched.

const MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "en",
  "for",
  "if",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "so",
  "the",
  "to",
  "v",
  "via",
  "vs",
  "yet",
]);

export function titleCase(title: string): string {
  const words = title.split(" ");
  return words
    .map((word, i) => {
      if (word === "") return word;
      // First/last word, and the word right after a colon or dash, stay
      // as-is. Some titles in this collection use "_" as a colon substitute
      // (e.g. "Wagner_ Operatic Scenes From The Ring") — treat that the
      // same way, so the subtitle's first word doesn't get lowercased.
      const prev = words[i - 1];
      if (
        i === 0 ||
        i === words.length - 1 ||
        prev?.endsWith(":") ||
        prev?.endsWith("-") ||
        prev?.endsWith("_")
      ) {
        return word;
      }
      const match = word.match(/^([("'“]*)([A-Za-z.]+)([),.;:!?"'”]*)$/);
      if (!match) return word;
      const [, prefix, core, suffix] = match;
      if (!MINOR_WORDS.has(core.toLowerCase())) return word;
      return `${prefix}${core.toLowerCase()}${suffix}`;
    })
    .join(" ");
}
