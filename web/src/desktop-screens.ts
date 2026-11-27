import { t } from "../../shared/i18n.ts";
import { useAppSelect } from "./store.ts";

export function useDesktopScreens() {
  return useAppSelect(s => s.desktopScreens);
}

export async function startDesktopScreen(id: string): Promise<void> {
  const response = await fetch(`/api/desktop/screens/${encodeURIComponent(id)}/start`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? t("无法启动屏幕。"));
  }
}
