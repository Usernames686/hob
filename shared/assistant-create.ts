import { t } from "./i18n.ts";
import { distinctPetSprite, parsePetDirect } from "./pet.ts";
import type { Assistant, CreateAssistantBody } from "./types.ts";

export const ASSISTANT_NAME_LIMIT = 40;
export const DUTY_LIMIT = 8;

export function assistantNameError(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return t("请为助手命名。");
  if ([...name.trim()].length > ASSISTANT_NAME_LIMIT) return t("助手名字最多 {n} 个字。", { n: ASSISTANT_NAME_LIMIT });
  return null;
}

export function assistantSlugBase(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function assistantNameTaken(assistants: Pick<Assistant, "id" | "name">[], name: string, id: string): boolean {
  return assistants.some(a => a.id === id || a.name.trim().toLowerCase() === name.toLowerCase());
}

/** 头像下方的一行职责按字符截断，保留完整的 Unicode 字符。 */
export function clampDuty(value: string, max = DUTY_LIMIT): string {
  return [...value.trim().replace(/\s+/g, " ")].slice(0, max).join("").trimEnd();
}

export function assistantDetails(body: CreateAssistantBody) {
  if ([body.duty, body.dutyLong, body.instructions].some(value => value !== undefined && typeof value !== "string")) {
    throw new Error(t("职责和补充提示词必须是文字。"));
  }
  return {
    name: body.name.trim(),
    duty: clampDuty(body.duty ?? ""),
    dutyLong: body.dutyLong?.trim() ?? "",
    ...(body.instructions?.trim() ? { instructions: body.instructions.trim() } : {}),
  };
}

export function manualAssistantSprite(sprite: string | undefined, taken: string[]): string {
  if (sprite === undefined) return distinctPetSprite(undefined, taken);
  if (typeof sprite !== "string" || !parsePetDirect(sprite)) throw new Error(t("头像无效。"));
  return sprite;
}

export function assistantAbilities(raw: unknown): NonNullable<Assistant["abilities"]> {
  const defaults = { exec: true, write: true, image: true };
  if (raw === undefined) return defaults;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(t("能力开关只能是开启或关闭。"));
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(defaults, key) || typeof value !== "boolean") throw new Error(t("能力开关只能是开启或关闭。"));
    defaults[key as keyof typeof defaults] = value;
  }
  return defaults;
}

export function assistantGreeting(name: string, duty?: string): string {
  return duty ? t("我是{assistant}，负责{duty}。", { assistant: name, duty }) : t("我是{assistant}，有什么想让我帮忙的？", { assistant: name });
}
