// 系统事件那一轮的「不说话」出口：模型只回 NO_REPLY，这一轮写的字都不给用户看。

export const NO_REPLY = "NO_REPLY";

/** 收尾时清理完整正文两端的静默标记。 */
export function stripNoReply(text: string): string {
  let out = text.trim();
  while (out.startsWith(NO_REPLY)) out = out.slice(NO_REPLY.length).trimStart();
  while (out.endsWith(NO_REPLY)) out = out.slice(0, -NO_REPLY.length).trimEnd();
  return out;
}

/** 这一段是在说「这一轮不用说」：去掉首尾空白后整段就是它，或者以它开头、以它结尾。 */
export function saysNoReply(text: string): boolean {
  const out = text.trim();
  return !!out && (out.startsWith(NO_REPLY) || out.endsWith(NO_REPLY));
}
