import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { newId } from "./ids.ts";

export function readSessionFile(file: string): { header: SessionHeader | null; entries: SessionEntry[] } {
  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as SessionHeader | SessionEntry;
        if (entry?.type === "session") header ??= entry;
        else if (entry?.type) entries.push(entry);
      } catch {
        // 与原先的会话读取一致：忽略写到一半的记录，原文件仍完整留在备份里。
      }
    }
  }
  return { header, entries };
}

/** 按原来的顺序保留条目，已经去掉父节点的分支一并去掉。 */
export function keepSessionEntries(entries: SessionEntry[], keep: (entry: SessionEntry) => boolean): SessionEntry[] {
  const ids = new Set<string>();
  return entries.filter((entry) => {
    if (!keep(entry) || entry.parentId != null && !ids.has(entry.parentId)) return false;
    ids.add(entry.id);
    return true;
  });
}

export function rewindSession(file: string, before: string): { change?: { file: string; lines: unknown[] }; lastTimestamp?: string } {
  const { header, entries } = readSessionFile(file);
  if (!header) return {};
  const kept = keepSessionEntries(entries, (entry) => entry.timestamp < before);
  return {
    ...(kept.length !== entries.length ? { change: { file, lines: [header, ...kept] } } : {}),
    lastTimestamp: kept.at(-1)?.timestamp,
  };
}

/** 先备份并写好临时文件，再逐个替换；失败时恢复已经替换的文件。 */
export function writeRewindFiles(changes: { file: string; lines: unknown[] }[], saveState: () => void): void {
  const suffix = newId(`${new Date().toISOString().replace(/[:.]/g, "-")}-`);
  const staged = changes.map(({ file, lines }) => ({
    file, lines, tmp: `${file}.${suffix}.tmp`,
    backup: existsSync(file) ? join(dirname(file), ".rewind-backups", `${basename(file)}.${suffix}.bak`) : undefined,
  }));
  const written: typeof staged = [];
  try {
    for (const { file, lines, tmp, backup } of staged) {
      if (backup) {
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(file, backup);
      }
      writeFileSync(tmp, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    }
    for (const change of staged) {
      renameSync(change.tmp, change.file);
      written.push(change);
    }
    saveState();
  } catch (error) {
    for (const { file, tmp, backup } of written.reverse()) {
      if (backup) {
        copyFileSync(backup, tmp);
        renameSync(tmp, file);
      } else rmSync(file, { force: true });
    }
    throw error;
  } finally {
    for (const { tmp } of staged) rmSync(tmp, { force: true });
  }
}
