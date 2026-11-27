import { isAbsolute, relative } from "node:path";

export { clampDuty } from "../../shared/assistant-create.ts";

/** 活动流里的路径：在工作目录下的就显示相对路径。 */
export function showPath(path: string, cwd: string): string {
  if (!path || !cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** 模型服务的报错压成一句：「my-proxy API error (429): {"message":"…"}」→「模型服务返回 429：…」。 */
export function briefModelError(raw: string | undefined): string {
  if (!raw) return "模型服务出错";
  const code = raw.match(/\((\d{3})\)/)?.[1];
  const detail = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? raw.replace(/\s+/g, " ");
  const short = detail.length > 120 ? `${detail.slice(0, 119)}…` : detail;
  return code ? `模型服务返回 ${code}：${short}` : short;
}
