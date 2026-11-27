import { t } from "./i18n.ts";

const MAX_SUGGESTED_TITLE_CHARS = 20;
const MAX_EXPORT_FILENAME_CHARS = 40;
const ILLEGAL_FILENAME_CHARS = /[/\\<>:"|?*\p{Cc}.]+/gu;

function stripMarkdownLine(raw: string): string {
  return raw
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+•·]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^[@#*\->`]+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeBaseName(raw: string, maxChars: number): string {
  const cleaned = raw
    .replace(ILLEGAL_FILENAME_CHARS, "-")
    .replace(/[\s·•]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(cleaned).slice(0, maxChars).join("").replace(/-+$/g, "");
}

function extractLeadLine(markdownText: string): string {
  const lines = markdownText.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let firstMeaningful = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed) continue;
    if (/^<!--.*-->$/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed)) continue;
    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = stripMarkdownLine(trimmed);
      if (heading) return heading;
    }
    if (!firstMeaningful) {
      const candidate = stripMarkdownLine(trimmed);
      if (candidate) firstMeaningful = candidate;
    }
  }
  return firstMeaningful;
}

/** 从一段 Markdown 文本推导简洁的白板文档标题与合法 `.md` 文件名。 */
export function suggestArtifactTitleAndName(
  markdownText: string,
  fallbackTitle: string,
): { title: string; name: string } {
  const fallback = fallbackTitle.trim() || "document";
  const lead = extractLeadLine(markdownText) || fallback;
  const title = Array.from(lead).slice(0, MAX_SUGGESTED_TITLE_CHARS).join("").trim() || fallback;
  let base = sanitizeBaseName(title, MAX_SUGGESTED_TITLE_CHARS);
  if (!base || base.toLowerCase() === "artifacts") {
    base = sanitizeBaseName(fallback, MAX_SUGGESTED_TITLE_CHARS) || "document";
  }
  return { title, name: `${base}.md` };
}

/** 将标题与日期规范化为安全的 `<safe>-YYYY-MM-DD.md` 导出文件名。 */
export function safeExportFilename(title: string, dateStr: string): string {
  const base = sanitizeBaseName(title, MAX_EXPORT_FILENAME_CHARS) || "conversation";
  const safeDate = dateStr.replace(/[^0-9-]/g, "") || "export";
  return `${base}-${safeDate}.md`;
}

export interface ExportConversationMessage {
  speaker: string;
  at: string;
  text: string;
  quote?: string;
  files?: string[];
}

/** 将完整对话格式化为清晰易读的 Markdown 文档。 */
export function formatConversationMarkdown(input: {
  title: string;
  subtitle?: string;
  exportedAt: string;
  messages: ExportConversationMessage[];
}): string {
  const lines: string[] = [`# ${input.title.trim() || "Conversation"}`, ""];
  const metaParts: string[] = [];
  if (input.subtitle?.trim()) metaParts.push(input.subtitle.trim());
  metaParts.push(t("导出时间：{time}", { time: input.exportedAt }));
  lines.push(`> ${metaParts.join(" · ")}`, "");

  if (input.messages.length === 0) {
    lines.push(t("（暂无消息）"), "");
    return lines.join("\n");
  }

  const blocks = input.messages.map((message) => {
    const parts: string[] = [];
    const header = message.at ? `### ${message.speaker} · ${message.at}` : `### ${message.speaker}`;
    parts.push(header);
    if (message.quote?.trim()) {
      const quoted = message.quote.replace(/\r?\n/g, " ").trim();
      parts.push(`> ${t("引用：{text}", { text: quoted })}`);
    }
    if (message.files?.length) {
      parts.push(`_${t("附件：{files}", { files: message.files.join(", ") })}_`);
    }
    if (message.text.trim()) {
      parts.push(message.text.trim());
    }
    return parts.join("\n\n");
  });

  lines.push(blocks.join("\n\n---\n\n"), "");
  return lines.join("\n");
}
