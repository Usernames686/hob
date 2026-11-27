import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../shared/i18n.ts";
import type { LocalMemoryEntry, LocalMemoryView, ScratchpadEntry } from "../../shared/types.ts";
import { memoryDir } from "./config.ts";

export const MAX_MEMORY_BYTES = 512 * 1024;
export const MAX_MEMORY_ENTRY_CHARS = 20_000;

const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_FILE_REGEX = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** 与 pi-memory 完全一致的记忆条目元数据注释行格式。 */
const MEMORY_ENTRY_META_COMMENT_REGEX =
  /^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const MEMORY_ENTRY_META_CAPTURE =
  /^<!-- (?:last updated: |HANDOFF )?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([^\]\r\n]+)\] -->$/;

const SCRATCHPAD_ITEM_REGEX = /^- \[([ xX])\] (.+)$/;
const SCRATCHPAD_META_COMMENT_REGEX = /^<!-- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function nowTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

export function isValidDailyDate(date: string): boolean {
  if (!DAILY_DATE_REGEX.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function assertSafePath(path: string, expectDir: boolean): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(t("记忆目录或文件不能是符号链接"));
  if (expectDir && !stat.isDirectory()) throw new Error(t("记忆目录无效"));
  if (!expectDir && !stat.isFile()) throw new Error(t("记忆文件无效"));
  return true;
}

function readSafeFile(filePath: string): string | null {
  if (!assertSafePath(filePath, false)) return null;
  const stat = lstatSync(filePath);
  if (stat.size > MAX_MEMORY_BYTES) throw new Error(t("记忆文件不能超过 512 KiB"));
  return readFileSync(filePath, "utf8");
}

function writeAtomic(dir: string, filePath: string, content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) {
    throw new Error(t("记忆文件不能超过 512 KiB"));
  }
  mkdirSync(dir, { recursive: true });
  assertSafePath(dir, true);
  assertSafePath(filePath, false);
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
}

interface ParsedMemoryBlock {
  id: string;
  raw: string;
  text: string;
  updatedAt?: string;
  source?: string;
}

function parseMemoryBlocks(content: string, prefix: "lt" | "dy"): ParsedMemoryBlock[] {
  const normalized = normalizeNewlines(content);
  const rawBlocks: Array<{ raw: string; metaLine?: string; text: string }> = [];
  let currentLines: string[] = [];
  let currentIsStamped = false;

  const flush = () => {
    const joined = currentLines.join("\n").trim();
    if (!joined) return;
    if (currentIsStamped) {
      const metaLine = currentLines[0]!;
      const body = currentLines.slice(1).join("\n").trim();
      if (!body) return;
      rawBlocks.push({ raw: `${metaLine}\n${body}`, metaLine, text: body });
    } else {
      for (const paragraph of joined.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (trimmed) rawBlocks.push({ raw: trimmed, text: trimmed });
      }
    }
  };

  for (const line of normalized.split("\n")) {
    if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line)) {
      flush();
      currentLines = [line];
      currentIsStamped = true;
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return rawBlocks.map((block, index) => {
    const metaMatch = block.metaLine ? MEMORY_ENTRY_META_CAPTURE.exec(block.metaLine) : null;
    return {
      id: `${prefix}-${index}-${shortHash(block.raw)}`,
      raw: block.raw,
      text: block.text,
      ...(metaMatch ? { updatedAt: metaMatch[1], source: metaMatch[2] } : {}),
    };
  });
}

function serializeMemoryBlocks(blocks: Array<{ raw: string }>): string {
  if (!blocks.length) return "";
  return `${blocks.map((block) => block.raw).join("\n\n")}\n`;
}

function toEntry(block: ParsedMemoryBlock): LocalMemoryEntry {
  return {
    id: block.id,
    text: block.text,
    ...(block.updatedAt ? { updatedAt: block.updatedAt } : {}),
    ...(block.source ? { source: block.source } : {}),
  };
}

interface ParsedScratchpadLine {
  id: string;
  lineIndex: number;
  done: boolean;
  text: string;
  updatedAt?: string;
}

function parseScratchpadLines(content: string): { lines: string[]; entries: ParsedScratchpadLine[] } {
  const normalized = normalizeNewlines(content);
  const lines = normalized.split("\n");
  const entries: ParsedScratchpadLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = SCRATCHPAD_ITEM_REGEX.exec(line);
    if (!match) continue;
    const prev = i > 0 ? lines[i - 1]! : "";
    const metaMatch = SCRATCHPAD_META_COMMENT_REGEX.exec(prev);
    entries.push({
      id: `sp-${i}-${shortHash(line)}`,
      lineIndex: i,
      done: match[1]!.toLowerCase() === "x",
      text: match[2]!,
      ...(metaMatch ? { updatedAt: metaMatch[1] } : {}),
    });
  }
  return { lines, entries };
}

function toScratchpadEntry(item: ParsedScratchpadLine): ScratchpadEntry {
  return {
    id: item.id,
    text: item.text,
    done: item.done,
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
  };
}

function listDailyDates(dir: string): string[] {
  const dailyDir = join(dir, "daily");
  if (!assertSafePath(dailyDir, true)) return [];
  const dates: string[] = [];
  for (const entry of readdirSync(dailyDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const match = DAILY_FILE_REGEX.exec(entry.name);
    if (!match) continue;
    const date = match[1]!;
    if (isValidDailyDate(date)) dates.push(date);
  }
  return dates.sort((a, b) => b.localeCompare(a));
}

function validateMemoryText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(t("记忆内容不能为空"));
  if (trimmed.length > MAX_MEMORY_ENTRY_CHARS) {
    throw new Error(t("单条记忆不能超过 20000 字"));
  }
  return trimmed;
}

function validateScratchpadText(raw: string): string {
  const cleaned = raw.replace(/[\r\n]+/g, " ").trim();
  if (!cleaned) throw new Error(t("备忘内容不能为空"));
  if (cleaned.length > MAX_MEMORY_ENTRY_CHARS) {
    throw new Error(t("单条备忘不能超过 20000 字"));
  }
  return cleaned;
}

export function readLocalMemory(home: string, requestedDate?: string): LocalMemoryView {
  if (requestedDate !== undefined && !isValidDailyDate(requestedDate)) {
    throw new Error(t("日期格式无效，应为 YYYY-MM-DD"));
  }
  const dir = memoryDir(home);
  if (!assertSafePath(dir, true)) {
    return {
      longTerm: [],
      scratchpad: [],
      dailyDates: [],
      ...(requestedDate ? { dailyDate: requestedDate } : {}),
      daily: [],
    };
  }

  const memoryContent = readSafeFile(join(dir, "MEMORY.md"));
  const longTerm = memoryContent ? parseMemoryBlocks(memoryContent, "lt").map(toEntry) : [];

  const scratchpadContent = readSafeFile(join(dir, "SCRATCHPAD.md"));
  const scratchpad = scratchpadContent
    ? parseScratchpadLines(scratchpadContent).entries.map(toScratchpadEntry)
    : [];

  const dailyDates = listDailyDates(dir);
  const dailyDate = requestedDate ?? dailyDates[0];
  let daily: LocalMemoryEntry[] = [];
  if (dailyDate) {
    const dailyDir = join(dir, "daily");
    if (assertSafePath(dailyDir, true)) {
      const dailyContent = readSafeFile(join(dailyDir, `${dailyDate}.md`));
      if (dailyContent) daily = parseMemoryBlocks(dailyContent, "dy").map(toEntry);
    }
  }

  return {
    longTerm,
    scratchpad,
    dailyDates,
    ...(dailyDate ? { dailyDate } : {}),
    daily,
  };
}

export function addLongTermMemory(home: string, text: string): LocalMemoryView {
  const cleaned = validateMemoryText(text);
  const dir = memoryDir(home);
  assertSafePath(dir, true);
  const filePath = join(dir, "MEMORY.md");
  const existing = readSafeFile(filePath);
  const blocks = existing ? parseMemoryBlocks(existing, "lt") : [];
  const nextRaw = `<!-- ${nowTimestamp()} [user] -->\n${cleaned}`;
  const serialized = serializeMemoryBlocks([...blocks, { raw: nextRaw }]);
  writeAtomic(dir, filePath, serialized);
  return readLocalMemory(home);
}

export function updateLongTermMemory(home: string, id: string, text: string): LocalMemoryView | undefined {
  const cleaned = validateMemoryText(text);
  const dir = memoryDir(home);
  if (!assertSafePath(dir, true)) return undefined;
  const filePath = join(dir, "MEMORY.md");
  const existing = readSafeFile(filePath);
  if (!existing) return undefined;
  const blocks = parseMemoryBlocks(existing, "lt");
  const index = blocks.findIndex((block) => block.id === id);
  if (index < 0) return undefined;
  const updated = blocks.map((block, idx) =>
    idx === index ? { raw: `<!-- last updated: ${nowTimestamp()} [user] -->\n${cleaned}` } : block,
  );
  writeAtomic(dir, filePath, serializeMemoryBlocks(updated));
  return readLocalMemory(home);
}

export function deleteLongTermMemory(home: string, id: string): LocalMemoryView | undefined {
  const dir = memoryDir(home);
  if (!assertSafePath(dir, true)) return undefined;
  const filePath = join(dir, "MEMORY.md");
  const existing = readSafeFile(filePath);
  if (!existing) return undefined;
  const blocks = parseMemoryBlocks(existing, "lt");
  const kept = blocks.filter((block) => block.id !== id);
  if (kept.length === blocks.length) return undefined;
  writeAtomic(dir, filePath, serializeMemoryBlocks(kept));
  return readLocalMemory(home);
}

export function deleteDailyMemory(home: string, date: string, id: string): LocalMemoryView | undefined {
  if (!isValidDailyDate(date)) throw new Error(t("日期格式无效，应为 YYYY-MM-DD"));
  const dir = memoryDir(home);
  if (!assertSafePath(dir, true)) return undefined;
  const dailyDir = join(dir, "daily");
  if (!assertSafePath(dailyDir, true)) return undefined;
  const filePath = join(dailyDir, `${date}.md`);
  const existing = readSafeFile(filePath);
  if (!existing) return undefined;
  const blocks = parseMemoryBlocks(existing, "dy");
  const kept = blocks.filter((block) => block.id !== id);
  if (kept.length === blocks.length) return undefined;
  if (kept.length === 0) {
    rmSync(filePath, { force: true });
    return readLocalMemory(home);
  }
  writeAtomic(dailyDir, filePath, serializeMemoryBlocks(kept));
  return readLocalMemory(home, date);
}

export function addScratchpadItem(home: string, text: string): LocalMemoryView {
  const cleaned = validateScratchpadText(text);
  const dir = memoryDir(home);
  assertSafePath(dir, true);
  const filePath = join(dir, "SCRATCHPAD.md");
  const existing = readSafeFile(filePath);
  const meta = `<!-- ${nowTimestamp()} [user] -->`;
  const nextContent = !existing || !existing.trim()
    ? `# Scratchpad\n\n${meta}\n- [ ] ${cleaned}\n`
    : `${normalizeNewlines(existing).replace(/\n+$/, "")}\n${meta}\n- [ ] ${cleaned}\n`;
  writeAtomic(dir, filePath, nextContent);
  return readLocalMemory(home);
}

export function updateScratchpadItem(
  home: string,
  id: string,
  patch: { text?: string; done?: boolean },
): LocalMemoryView | undefined {
  const nextTextInput = patch.text !== undefined ? validateScratchpadText(patch.text) : undefined;
  const dir = memoryDir(home);
  if (!assertSafePath(dir, true)) return undefined;
  const filePath = join(dir, "SCRATCHPAD.md");
  const existing = readSafeFile(filePath);
  if (!existing) return undefined;
  const { lines, entries } = parseScratchpadLines(existing);
  const target = entries.find((entry) => entry.id === id);
  if (!target) return undefined;
  const nextDone = patch.done !== undefined ? patch.done : target.done;
  const nextText = nextTextInput ?? target.text;
  lines[target.lineIndex] = `- [${nextDone ? "x" : " "}] ${nextText}`;
  const joined = lines.join("\n");
  writeAtomic(dir, filePath, joined.endsWith("\n") ? joined : `${joined}\n`);
  return readLocalMemory(home);
}

export function deleteScratchpadItem(home: string, id: string): LocalMemoryView | undefined {
  const dir = memoryDir(home);
  if (!assertSafePath(dir, true)) return undefined;
  const filePath = join(dir, "SCRATCHPAD.md");
  const existing = readSafeFile(filePath);
  if (!existing) return undefined;
  const { lines, entries } = parseScratchpadLines(existing);
  const target = entries.find((entry) => entry.id === id);
  if (!target) return undefined;
  const dropIndices = new Set<number>([target.lineIndex]);
  if (target.lineIndex > 0 && SCRATCHPAD_META_COMMENT_REGEX.test(lines[target.lineIndex - 1]!)) {
    dropIndices.add(target.lineIndex - 1);
  }
  const out = lines.filter((_, idx) => !dropIndices.has(idx));
  const joined = out.join("\n");
  const finalContent = joined.trim() ? (joined.endsWith("\n") ? joined : `${joined}\n`) : "";
  writeAtomic(dir, filePath, finalContent);
  return readLocalMemory(home);
}

export function clearDoneScratchpad(home: string): LocalMemoryView {
  const dir = memoryDir(home);
  if (!assertSafePath(dir, true)) return readLocalMemory(home);
  const filePath = join(dir, "SCRATCHPAD.md");
  const existing = readSafeFile(filePath);
  if (!existing) return readLocalMemory(home);
  const lines = normalizeNewlines(existing).split("\n");
  const out: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const match = SCRATCHPAD_ITEM_REGEX.exec(line);
    if (match && match[1]!.toLowerCase() === "x") {
      removed++;
      if (out.length > 0 && SCRATCHPAD_META_COMMENT_REGEX.test(out[out.length - 1]!)) {
        out.pop();
      }
      continue;
    }
    out.push(line);
  }
  if (removed > 0) {
    const joined = out.join("\n");
    const finalContent = joined.trim() ? (joined.endsWith("\n") ? joined : `${joined}\n`) : "";
    writeAtomic(dir, filePath, finalContent);
  }
  return readLocalMemory(home);
}
