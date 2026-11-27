import { assistantSlugBase } from "../../shared/assistant-create.ts";
import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(prefix: string, length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}${out}`;
}

/** 中文 slug：英文/数字保留，其余按拼音做不到就退回随机后缀。 */
export function slugify(name: string): string {
  return assistantSlugBase(name) || newId("a-", 4);
}
