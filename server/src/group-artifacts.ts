import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../shared/i18n.ts";
import { artifactNameKey, MAX_ARTIFACT_BYTES, normalizeArtifactName } from "../../shared/group-artifact.ts";
import type { GroupArtifact, GroupArtifactMeta } from "../../shared/types.ts";
import { groupDir } from "./config.ts";

const INDEX = "artifacts.json";
export { MAX_ARTIFACT_BYTES, normalizeArtifactName };

function artifactDir(home: string, gid: string): string {
  return join(groupDir(home, gid), "artifacts");
}

function readIndex(dir: string): Map<string, GroupArtifactMeta> {
  const path = join(dir, INDEX);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return new Map();
  let rows: unknown;
  try { rows = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const entries = Array.isArray(rows) ? rows as Partial<GroupArtifactMeta>[] : [];
  return new Map(entries.flatMap((row) => row && typeof row.name === "string" && typeof row.title === "string" &&
    typeof row.updatedBy === "string" && typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt)) &&
    typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version > 0
    ? [[row.name, { name: row.name, title: row.title, updatedBy: row.updatedBy, updatedAt: row.updatedAt, version: row.version, size: 0 }]]
    : []));
}

function listArtifacts(dir: string): GroupArtifactMeta[] {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const index = readIndex(dir);
  const items = readdirSync(dir, { withFileTypes: true }).flatMap((entry): GroupArtifactMeta[] => {
    const { name } = entry;
    if (!entry.isFile() || !/\.md$/i.test(name)) return [];
    try { if (normalizeArtifactName(name) !== name) return []; }
    catch { return []; }
    const stat = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (!stat?.isFile()) return [];
    const previous = index.get(name);
    // 索引丢失或有人直接放了 Markdown，文件仍然可读。
    return [previous ? { ...previous, size: stat.size } : {
      name, title: name.slice(0, -3), updatedBy: "", updatedAt: stat.mtime.toISOString(), version: 1, size: stat.size,
    }];
  });
  return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.name.localeCompare(b.name));
}

export function listGroupArtifacts(home: string, gid: string): GroupArtifactMeta[] {
  return listArtifacts(artifactDir(home, gid));
}

function findArtifact(items: GroupArtifactMeta[], name: string): GroupArtifactMeta | undefined {
  const key = artifactNameKey(name);
  return items.find((item) => item.name === name) ?? items.find((item) => artifactNameKey(item.name) === key);
}

export function readGroupArtifact(home: string, gid: string, rawName: string): GroupArtifact | undefined {
  const name = normalizeArtifactName(rawName);
  const dir = artifactDir(home, gid);
  const meta = findArtifact(listArtifacts(dir), name);
  if (!meta) return undefined;
  try { return { ...meta, content: readFileSync(join(dir, meta.name), "utf8") }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 两份文件都先写到同一目录下的临时空间，再原子替换。索引更新失败时恢复原文件。
 * 同一进程内这里没有 await，版本号和索引不会被其他请求交叉改写。
 */
function saveChange(dir: string, name: string, index: GroupArtifactMeta[], content?: string): void {
  const path = join(dir, name);
  const staging = mkdtempSync(join(dir, ".artifact-"));
  const previous = join(staging, "previous");
  const next = join(staging, "next");
  const nextIndex = join(staging, INDEX);
  const hadFile = lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  try {
    writeFileSync(nextIndex, `${JSON.stringify(index, null, 2)}\n`);
    if (content === undefined) renameSync(path, previous);
    else {
      if (hadFile) copyFileSync(path, previous);
      writeFileSync(next, content, "utf8");
      renameSync(next, path);
    }
    try { renameSync(nextIndex, join(dir, INDEX)); }
    catch (error) {
      if (hadFile) renameSync(previous, path);
      else rmSync(path, { force: true });
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export class ArtifactConflictError extends Error {
  readonly currentVersion: number;
  constructor(version: number) {
    super(t("文档已在别处更新（当前 v{version}），请刷新后再保存", { version }));
    this.name = "ArtifactConflictError";
    this.currentVersion = version;
  }
}

export function writeGroupArtifact(home: string, gid: string, input: { name: string; title?: string; content: string; updatedBy: string; expectedVersion?: number }): GroupArtifact {
  const requested = normalizeArtifactName(input.name);
  const size = Buffer.byteLength(input.content, "utf8");
  if (size > MAX_ARTIFACT_BYTES) throw new Error(t("文档不能超过 512 KiB"));
  const dir = artifactDir(home, gid);
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Error(t("白板目录无效"));
  const items = listArtifacts(dir);
  const current = findArtifact(items, requested);
  if (input.expectedVersion !== undefined && current && current.version !== input.expectedVersion) {
    throw new ArtifactConflictError(current.version);
  }
  const name = current?.name ?? requested;
  const meta = {
    name, title: input.title?.trim() || current?.title || name.slice(0, -3), size,
    updatedBy: input.updatedBy, updatedAt: new Date().toISOString(), version: (current?.version ?? 0) + 1,
  };
  saveChange(dir, name, [...items.filter((item) => item.name !== name), meta], input.content);
  return { ...meta, content: input.content };
}

export function deleteGroupArtifact(home: string, gid: string, rawName: string): boolean {
  const name = normalizeArtifactName(rawName);
  const dir = artifactDir(home, gid);
  const items = listArtifacts(dir);
  const current = findArtifact(items, name);
  if (!current) return false;
  saveChange(dir, current.name, items.filter((item) => item.name !== current.name));
  return true;
}

export function artifactsBlockText(home: string, gid: string, nameOf: (speaker: string) => string, timezone: string): string | undefined {
  const items = listGroupArtifacts(home, gid);
  if (!items.length) return undefined;
  const clock = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
  const entries = items.slice(0, 12).map(({ name, updatedBy, updatedAt, version }) => {
    const author = updatedBy === "user" ? "用户" : updatedBy ? nameOf(updatedBy) : "未知作者";
    return `${name}（${author} ${clock.format(new Date(updatedAt))} 更新，v${version}）`;
  });
  return `当前白板：${entries.join("、")}${items.length > 12 ? `等共 ${items.length} 份` : ""}`;
}
