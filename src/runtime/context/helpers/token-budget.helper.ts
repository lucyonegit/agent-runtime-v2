export function estimateTextTokens(value: string): number {
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (isCjkCodePoint(codePoint)) cjk += 1;
    else if (codePoint <= 0x7f) ascii += 1;
    else other += 1;
  }
  // Qwen tokenizes CJK text much closer to one token per character than the
  // old GPT-oriented chars/4 heuristic. The 10% margin also covers message
  // framing and JSON/tool-call structure that are absent from plain text.
  return Math.max(1, Math.ceil((cjk + ascii / 4 + other / 2) * 1.1));
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x323af)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}
