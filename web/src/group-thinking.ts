import { t } from "../../shared/i18n.ts";

export function groupThinkingText(name: string, activity?: { label?: string } | null): string {
  return activity?.label ? t("{name} · {label}", { name, label: activity.label }) : t("{name} 正在思考…", { name });
}

export function queuedMembersLabel(ids: readonly string[], nameOf: (id: string) => string): string {
  if (!ids.length) return "";
  const shown = ids.slice(0, 4).map(nameOf);
  const extra = ids.length - shown.length;
  return extra > 0 ? `${shown.join(" → ")} +${extra}` : shown.join(" → ");
}
