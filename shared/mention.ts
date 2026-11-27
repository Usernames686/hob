/** 围栏和行内代码里的点名只用于展示。 */
export function stripCodeForMentions(text: string): string {
  const fences = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)/gm;
  let cursor = 0;
  let cleaned = "";
  for (let open = fences.exec(text); open; open = fences.exec(text)) {
    const [, marker = "", info = ""] = open;
    if (marker[0] === "`" && info.includes("`")) continue;
    // 结束围栏用同一种符号，且至少与起始围栏一样长。
    const closing = new RegExp(`^[ \\t]*${marker[0]}{${marker.length},}[ \\t]*(?=\\r?$)`, "gm");
    closing.lastIndex = fences.lastIndex;
    const end = closing.exec(text);
    cleaned += `${text.slice(cursor, open.index)} `;
    cursor = end ? closing.lastIndex : text.length;
    if (!end) break;
    fences.lastIndex = cursor;
  }
  return (cleaned + text.slice(cursor)).replace(/(?<![`\\])(`+)(?!`)(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?(?<!`)\1(?!`)/g, " ");
}

export function isMentionPrefixBoundary(prevChar: string | undefined): boolean {
  return prevChar === undefined || !/[A-Za-z0-9._%+-]/.test(prevChar);
}

export function isMentionNameContinuation(name: string, nextChar: string | undefined): boolean {
  return nextChar !== undefined && /[A-Za-z0-9_]$/.test(name) && /[A-Za-z0-9_-]/.test(nextChar);
}

export function extractMentions(text: string, candidates: Array<{ id: string; name: string; aliases?: string[] }>): string[] {
  const cleaned = stripCodeForMentions(text);
  const labels = candidates
    .flatMap(({ id, name, aliases }) => [...new Set([name, ...(aliases ?? [])].filter(Boolean))]
      .map((label) => ({ id, label, isName: label === name })))
    .sort((a, b) => b.label.length - a.label.length || Number(b.isName) - Number(a.isName));
  const ids = new Set<string>();
  for (let at = 0; at < cleaned.length; at += 1) {
    const ch = cleaned[at];
    if (ch !== "@" && ch !== "＠") continue;
    if (!isMentionPrefixBoundary(cleaned[at - 1])) continue;
    const hit = labels.find(({ label }) => cleaned.startsWith(label, at + 1) && !isMentionNameContinuation(label, cleaned[at + 1 + label.length]));
    if (hit) ids.add(hit.id);
  }
  return [...ids];
}
