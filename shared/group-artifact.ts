import { t } from "./i18n.ts";

const MAX_NAME_LENGTH = 80;
export const MAX_ARTIFACT_BYTES = 512 * 1024;

export function normalizeArtifactName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_NAME_LENGTH || name.startsWith(".") || name.includes("..") ||
      /[/\\<>:"|?*\p{Cc}]/u.test(name) || name.toLowerCase() === "artifacts.json") {
    throw new Error(t("文档名无效，最多 80 个字符，不能含路径或特殊字符"));
  }
  if (/\.md$/i.test(name)) return name;
  if (name.includes(".")) throw new Error(t("文档名请使用 .md 结尾（或不写后缀自动补 .md）"));
  if (name.length + 3 > MAX_NAME_LENGTH) throw new Error(t("文档名无效，最多 80 个字符，不能含路径或特殊字符"));
  return `${name}.md`;
}

/** 文件名按原样展示，匹配时兼容不同文件系统的大小写和 Unicode 规范化。 */
export function artifactNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
