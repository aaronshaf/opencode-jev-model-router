export type TextPartLike = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
};

/**
 * Extract bounded non-synthetic user text for routing.
 * Returns empty string when there is nothing usable or the payload is too large.
 */
export function extractPromptText(
  parts: TextPartLike[] | undefined,
  maxBytes: number,
): string {
  const text = (parts || [])
    .filter(
      (part) =>
        part &&
        part.type === "text" &&
        part.synthetic !== true &&
        part.ignored !== true &&
        typeof part.text === "string",
    )
    .map((part) => (part.text ?? "").trim())
    .filter(Boolean)
    .join("\n");

  if (!text) return "";

  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;

  // Cut on a UTF-8 code-point boundary (never emit U+FFFD).
  let end = Math.min(maxBytes, bytes.byteLength);
  while (end > 0 && (bytes[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const lead = bytes[end - 1]!;
    const need =
      lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > 1 && end - 1 + need > maxBytes) end -= 1;
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}
