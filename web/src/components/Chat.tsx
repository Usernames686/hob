// 中间一栏：头部 + 消息区 + 输入框。
import { currentLocale, t } from "../../../shared/i18n.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AssistantSummary, ConversationRef, GroupItem, GroupReplyMode, GroupSummary, Item, ModelInfo, TodoItem } from "../../../shared/types.ts";
import { isImagePath } from "../../../shared/media.ts";
import { artifactNameKey, normalizeArtifactName } from "../../../shared/group-artifact.ts";
import { suggestArtifactTitleAndName } from "../../../shared/export-markdown.ts";
import { downloadMarkdownFile } from "../download.ts";
import { localPath } from "../outbox.ts";
import { pastedFiles } from "../pasted-files.ts";
import { fileIcon } from "../file-icons.ts";
import { Icon } from "../icons.tsx";
import { BrandIcon, brandForRef } from "../brand-icons.tsx";
import { fitThinking, rosterOptions } from "../model-list.ts";
import { fmtWhen } from "../util.ts";
import { groupThinkingText, queuedMembersLabel } from "../group-thinking.ts";
import { Avatar } from "../sprites.tsx";
import { deriveChatMood, typingLook, useJustFinished, useTypingPulse } from "../pet/pet-mood.ts";
import { applyMention, filterMembers, groupSuggestionPrefix, mentionAt, stepPick } from "../mention.ts";
import {
  collapsePanel,
  discardGroupQueue,
  expandPanel,
  toggleSideCollapsed,
  focusComposer,
  groupById,
  groupChatItems,
  groupSpeaking,
  leaveChat,
  loadGroupArtifacts,
  loadModels,
  loadOlderGroupItems,
  openArtifact,
  openGroupArtifactsTab,
  openSettings,
  openSheet,
  patchAssistant,
  patchGroup,
  removeAttachment,
  resumeGroupQueue,
  saveGroupArtifact,
  send,
  setNotice,
  setQuote,
  setSection,
  setText,
  stopAssistant,
  stopGroup,
  attach,
  chatItems,
  composerDraft,
  loadOlderItems,
  openFilePreview,
  openJob,
  photoUrl,
  rewindConversation,
  useApp,
} from "../store.ts";
import { useLeave } from "../motion.ts";
import { isStreamingTail } from "../merge.ts";
import { afterScroll, expectAfterResize } from "../stick.ts";
import { GroupItemList, ItemList } from "./Items.tsx";
import { GroupCluster, membersOf } from "./Groups.tsx";
import { ClosedTopic } from "./Topics.tsx";
import { TodoStrip, type RunningJob } from "./Todos.tsx";
import { DelayedText } from "./Empty.tsx";
import { ComposerPlus } from "./ComposerPlus.tsx";
import { DialogShell } from "./DialogShell.tsx";

export function conversationState(s: ReturnType<typeof useApp>) {
  const g = groupById(s, s.gsel);
  const a = g ? undefined : s.assistants.find((x) => x.id === s.sel);
  const items = g ? groupChatItems(s, g.id) : chatItems(s, s.sel);
  const loaded = g ? s.groupItems[g.id] !== undefined : s.sel ? s.items[s.sel] !== undefined : false;
  const busy = g ? g.busy.length > 0 : Boolean(a?.busy);
  return { g, a, items, loaded, busy, empty: Boolean((g || a) && loaded && items.length === 0 && !busy), thinking: busy && !isStreamingTail(items) };
}

/** 忙、但字还没出来时显示当前活动。 */
function Thinking({ leaving, gap, a }: { leaving: boolean; gap: boolean; a: AssistantSummary }) {
  return (
    <>
      {gap ? <div className="g" /> : null}
      <div className={`hov think${leaving ? " leaving" : ""}`}>
        <div className="activity-line" role="status">
          <Avatar sprite={a.sprite} size={46} free live interactive={false} glow motion={a.activity?.state === "tool" ? "work" : "think"} />
          <span className="activity-shimmer">{a.activity?.label ?? t("正在思考…")}</span>
        </div>
      </div>
    </>
  );
}

/**
 * 贴底滚动：内容变高（新条目、流式文字、卡片数据晚到、字体加载）或容器变矮（手机键盘弹出）时，若原本就在底部附近就保持在底部。
 * 内容自己变高、变矮、上面掉条目都会让浏览器挪滚动位置，这些都不算离开底部；判断规则见 stick.ts。
 * 新到一条时平滑滚过去；自己刚发的那条无论在哪都滚到底；首次加载、切换助手、重新拉整批对话时瞬间到底。
 * 返回现在是否贴底（回到底部的按钮用）和一个滚到底的函数。
 */
function useStickToBottom(
  ref: React.RefObject<HTMLDivElement | null>,
  expect: React.RefObject<number>,
  resetKey: string,
  len: number,
  firstId: string | undefined,
  mineLast: boolean,
) {
  const [stuck, setStuck] = useState(true);
  const pinned = useRef(true);
  const seen = useRef<{ key: string; len: number; firstId?: string }>({ key: "", len: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = () => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight });
    const onScroll = () => {
      const next = afterScroll(pinned.current, expect.current, box());
      expect.current = next.expect;
      if (next.stuck !== pinned.current) {
        pinned.current = next.stuck;
        setStuck(next.stuck);
      }
    };
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        expect.current = expectAfterResize(pinned.current, expect.current, box());
        if (pinned.current) el.scrollTop = expect.current;
      });
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [ref, expect]);

  // 在绘制前定位：进对话页时先画出顶部、下一帧再跳到底，就是那一下闪
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = seen.current;
    seen.current = { key: resetKey, len, firstId };
    if (last.key !== resetKey || len < last.len) {
      pinned.current = true;
      setStuck(true);
      el.scrollTop = el.scrollHeight;
      expect.current = el.scrollTop;
    } else if (len > last.len && last.firstId === firstId && (pinned.current || mineLast)) {
      pinned.current = true;
      setStuck(true);
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [ref, expect, resetKey, len, firstId, mineLast]);

  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setStuck(true);
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };

  return { atBottom: stuck, toBottom };
}

/**
 * 往上翻加载更早的消息：分页拼到前面以后把滚动位置让回原来那条，看的人不会跳。
 * 让位是程序自己动的，跟着记进预期位置，不然贴底那边会把它当成用户往上翻。
 */
function useOlderMessages(
  ref: React.RefObject<HTMLDivElement | null>,
  id: string | null,
  key: string,
  firstId: string | undefined,
  expect: React.RefObject<number>,
  group = false,
) {
  const anchor = useRef<{ id: string; top: number; key: string } | null>(null);
  const lastFirst = useRef<{ key: string; id?: string }>({ key: "" });
  const capture = () => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const node = Array.from(el.querySelectorAll<HTMLElement>("[data-item-id]")).find((item) => item.getBoundingClientRect().bottom > top);
    anchor.current = node ? { id: node.dataset.itemId!, top: node.getBoundingClientRect().top, key } : null;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const old = lastFirst.current;
    if (el && old.key === key && old.id && old.id !== firstId && anchor.current?.key === key) {
      const node = Array.from(el.querySelectorAll<HTMLElement>("[data-item-id]")).find((item) => item.dataset.itemId === anchor.current?.id);
      if (node) {
        el.scrollTop += node.getBoundingClientRect().top - anchor.current.top;
        expect.current = el.scrollTop;
      }
    }
    lastFirst.current = { key, id: firstId };
  }, [ref, key, firstId, expect]);
  return () => {
    const el = ref.current;
    if (!el || !id) return;
    capture();
    if (el.scrollTop < 120) void (group ? loadOlderGroupItems(id) : loadOlderItems(id));
  };
}

function OlderStatus({ id, group = false }: { id: string | null; group?: boolean }) {
  const s = useApp();
  const page = group ? s.groupPages[id ?? ""] : s.itemPages[id ?? ""];
  if (!page?.hasMore && !page?.loading && !page?.error) return null;
  return <div className="older-messages" role="status">{page.error ? <button onClick={() => id && void (group ? loadOlderGroupItems(id, true) : loadOlderItems(id, true))}>{t("读取失败：{error}", { error: page.error })} · {t("重试")}</button> : page.loading ? <DelayedText text={t("正在读取更早的消息…")} /> : null}</div>;
}

/** 最后一条是不是自己刚发的（转自别的助手的不算）。 */
function isMine(item: Item | undefined): boolean {
  return item?.kind === "user" && !item.from;
}

/** 回到底部：离开底部时出现，助手在回复时圈里是三个点。一直留在 DOM 里，靠透明度淡入淡出。 */
function JumpToBottom({ show, busy, onClick }: { show: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      className={`jump${show ? " show" : ""}`}
      onClick={onClick}
      title={t("回到最新消息")}
      aria-label={t("回到最新消息")}
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
    >
      {busy ? (
        <span className="jump-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon name="arrowDown" size={20} />
      )}
    </button>
  );
}

/** 这个对话里正在跑的任务，按卡片先后；交给输入框上方那一条显示。 */
function runningJobs(s: ReturnType<typeof useApp>, items: Item[]): RunningJob[] {
  const ids = [...new Set(items.flatMap((item) => (item.kind === "job" && s.jobs[item.jobId]?.status === "running" ? [item.jobId] : [])))];
  return ids.map((id) => {
    const job = s.jobs[id]!;
    return { id, title: job.title, since: job.startedAt ?? job.createdAt };
  });
}

/**
 * 顶上正中：一颗紧凑横向液态玻璃胶囊（小头像 + 名字与状态 + 轻箭头），点一下直接展开或收起右栏信息。
 */
function ChatHead({ g, a, parent, mobile, hasRightBtn }: { g?: GroupSummary; a?: AssistantSummary; parent?: GroupSummary; mobile?: boolean; hasRightBtn?: boolean }) {
  const s = useApp();
  const size = mobile ? 32 : 30;
  const owner = g && parent ? s.assistants.find((x) => x.id === g.ownerId) : undefined;
  const busy = g ? g.busy.length > 0 : Boolean(a?.busy);
  const draftText = composerDraft(s).text;
  const typing = useTypingPulse(draftText);
  const scopeKey = g ? `g:${g.id}` : `a:${a?.id ?? ""}`;
  const finished = useJustFinished(busy, scopeKey);
  const hasPendingAsk = a ? Object.values(s.approvals).some((ap) => ap.assistantId === a.id && ap.status === "pending") : false;
  const hasError = Boolean(s.notice && /失败|出错|错误|异常|error|failed/i.test(s.notice));
  const headMood = deriveChatMood({
    thinking: busy,
    busy,
    hasPendingAsk,
    hasError,
    typing,
    justFinished: finished.justFinished,
  });
  const headLook = typing ? typingLook(draftText) : undefined;
  const headAction = finished.justFinished ? ("bounce" as const) : undefined;
  const face = owner ? (
    <Avatar sprite={owner.sprite} size={size} live follow interactive={false} petState={headMood} focusLook={headLook} action={headAction} actionSeq={finished.seq} />
  ) : g ? (
    <GroupCluster g={g} assistants={s.assistants} size={size} />
  ) : a ? (
    <Avatar sprite={a.sprite} size={size} live follow interactive={false} petState={headMood} focusLook={headLook} action={headAction} actionSeq={finished.seq} />
  ) : null;
  // 话题只写话题名：在哪个群，左栏（手机上是返回键）已经交代了；名字长了一行省略，悬停看全名
  const sub = g && !parent ? <span className="ccap-sub">{t("综合 · {n} 位成员", { n: g.members.length })}</span> : null;
  const name = g?.name ?? a?.name ?? "";
  const artifactPage = g ? s.groupArtifacts?.[g.id] : undefined;
  const artifactCount = g ? (artifactPage?.loaded ? artifactPage.items.length : (g.artifactCount ?? 0)) : 0;
  const toggleInfo = () => {
    if (mobile) openSheet();
    else if (s.collapsed) expandPanel();
    else collapsePanel();
  };
  return (
    <>
      <button
        type="button"
        className={`ccap ccap-pill${sub ? "" : " solo"}${g && !owner ? " cluster" : ""}${busy ? " busy" : ""}`}
        title={mobile ? (g ? t("群信息") : t("助手信息")) : s.collapsed ? t("展开右栏") : t("收起右栏")}
        onClick={toggleInfo}
      >
        <span className="ccap-face">{face}</span>
        <span className="ccap-text">
          <span className="ccap-nm">{name}</span>
          {sub}
        </span>
        <Icon name="chev" size={13} className="ccap-chev" />
      </button>
      {g && artifactCount > 0 ? (
        <button
          type="button"
          className={`chead-doc${hasRightBtn ? " shifted" : ""}`}
          title={t("查看共享文档")}
          aria-label={t("查看共享文档")}
          onClick={() => openGroupArtifactsTab(g.id)}
        >
          <Icon name="doc" size={15} />
          <span>{artifactCount}</span>
        </button>
      ) : null}
    </>
  );
}

/** 交给主助手的几类事，点一下填进输入框（不直接发送）。 */
function examples(): string[] {
  return [t("查看这台电脑的磁盘和内存占用"), t("每天早上 9 点给我一份科技新闻简报"), t("把附件里的会议记录整理成要点")];
}

/**
 * 还没有任何消息时：说明这个助手做什么。还没配模型就先引导去设置，否则发出去只会得到一行报错。
 */
function EmptyChat({ a }: { a: AssistantSummary }) {
  const s = useApp();
  const models = s.settings.settings.models;
  const ready = models.roster.length > 0 && models.conversation.ref !== "";
  return (
    <div className="hello">
      <Avatar sprite={a.sprite} size={108} free live interactive follow ambient motion="home" />
      <div className="t">{a.primary ? t("我是{assistant}，你的主助手", { assistant: sendName(a.name, false) }) : t("我是{assistant}", { assistant: sendName(a.name, false) })}</div>
      <div className="d">
        {a.primary
          ? t("交给我的任务，我会分派给后台任务执行，完成、受阻或需要你确认时再告诉你；也可以让我定时执行。同类任务较多时，我会建议创建专属助手。")
          : t("负责{duty}。", { duty: a.duty })}
      </div>
      {ready ? (
        a.primary ? (
          <div className="ex">
            {examples().map((text) => (
              <button
                key={text}
                className="hob-btn"
                onClick={() => {
                  setText(text);
                  focusComposer();
                }}
              >
                {text}
              </button>
            ))}
          </div>
        ) : null
      ) : (
        <div className="setup">
          <div>{t("开始使用前，请先添加模型服务商并选择模型。")}</div>
          <button
            className="hob-btn hob-btn-primary"
            onClick={() => {
              openSettings();
              setSection("providers");
            }}
          >
            {t("前往设置")}
          </button>
        </div>
      )}
    </div>
  );
}

/** 接力排队进度：显示接下来按序发言的成员接力条。 */
function GroupQueueTrail({ g }: { g: GroupSummary }) {
  const s = useApp();
  const pending = g.queue && !g.queue.paused ? g.queue.pending : [];
  if (!pending.length) return null;
  const shown = pending.slice(0, 4);
  const extra = pending.length - shown.length;
  return (
    <div className="group-queue" role="status">
      <span className="group-queue-label">{t("接下来")}</span>
      <div className="group-queue-list">
        {shown.map((id, i) => {
          const m = s.assistants.find((a) => a.id === id);
          const name = m?.name ?? id;
          return (
            <span className="group-queue-step" key={id}>
              {i > 0 ? <span className="group-queue-arrow" aria-hidden="true">→</span> : null}
              <span className="group-queue-chip">
                {m ? <Avatar sprite={m.sprite} size={18} /> : null}
                <span>{name}</span>
              </span>
            </span>
          );
        })}
        {extra > 0 ? <span className="group-queue-more">+{extra}</span> : null}
      </div>
    </div>
  );
}

/** 群里正在说话的成员：底部一行一个人，头像 +「名字 正在思考…」，下方跟接力排队进度。 */
function GroupThinking({ g }: { g: GroupSummary }) {
  const s = useApp();
  const speaking = groupSpeaking(s, g);
  const hasQueue = Boolean(g.queue && !g.queue.paused && g.queue.pending.length > 0);
  if (!speaking.length && !hasQueue) return null;
  return (
    <>
      <div className="g" />
      {speaking.map((id) => {
        const m = s.assistants.find((a) => a.id === id);
        if (!m) return null;
        const activity = s.groupActivity[g.id]?.[id];
        return (
          <div className="hov think" key={id}>
            <div className="activity-line" role="status">
              <Avatar sprite={m.sprite} size={40} free live interactive={false} glow motion={activity?.state === "tool" ? "work" : "think"} />
              <span className="activity-shimmer">{groupThinkingText(sendName(m.name), activity)}</span>
            </div>
          </div>
        );
      })}
      <GroupQueueTrail g={g} />
    </>
  );
}

/** 还没说过话的群：说明这个群负责什么；话题里改成说明这件事就放在这里。 */
function EmptyGroup({ g }: { g: GroupSummary }) {
  const s = useApp();
  return (
    <div className="hello">
      <GroupCluster g={g} assistants={s.assistants} size={88} />
      <div className="t">{g.name}</div>
      <div className="d">{g.parentId ? t("这件事的讨论、提问和进展都放在这个话题里。") : g.purpose}</div>
    </div>
  );
}

/** 话题顶上那行灰字：谁开的、什么时候。（服务端记的是 createdBy） */
function openLine(g: GroupSummary, assistants: AssistantSummary[]): string {
  const who = g.createdBy && g.createdBy !== "user"
    ? t("{name}在综合创建了话题", { name: assistants.find((a) => a.id === g.createdBy)?.name ?? g.createdBy })
    : t("你创建了这个话题");
  return `${who} · ${fmtWhen(g.createdAt)}`;
}

/**
 * 名字嵌进中文句子：中文名直接连着写，英文名和前后的汉字之间留一个空格（「给 Hob 发消息」「给服务器发消息」）。
 * tail=false：后面紧跟标点或句子结束，不留后空格。
 */
export function sendName(name: string, tail = true): string {
  // 中英文之间补空格是中文排版的规矩，英文句子里的空格由译文自己带
  if (currentLocale() === "en") return name;
  const latin = (c: string | undefined) => Boolean(c && /[A-Za-z0-9]/.test(c));
  return `${latin(name[0]) ? " " : ""}${name}${tail && latin(name.at(-1)) ? " " : ""}`;
}

/** 当前对话整体的版本号：换了助手或重新拉了对话就变，用来判断该不该平滑滚动。 */
function chatKey(sel: string | null, gen: number | undefined): string {
  return `${sel ?? ""}|${gen ?? 0}`;
}

function RewindDialog({ conversation, item, removedCount, onClose }: { conversation: ConversationRef; item: Item; removedCount: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = t("回退到这里之前");
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rewindConversation(conversation, item.id);
      onClose();
    } catch (error) {
      setError(t("回退失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
      setBusy(false);
    }
  };
  return <DialogShell label={title} title={title} onClose={() => { if (!busy) onClose(); }} onSubmit={(event) => { event.preventDefault(); void submit(); }} actions={<>
    <button type="button" className="hob-btn" disabled={busy} onClick={onClose} autoFocus>{t("取消")}</button>
    <button type="submit" className="hob-btn hob-btn-danger" disabled={busy}>{t("确认回退")}</button>
  </>}>
    <div>{removedCount > 1 ? t("将移除这条及后续共 {n} 条消息，且无法撤销。", { n: removedCount }) : t("这条消息及其后续消息将从对话中移除，且无法撤销。")}</div>
    {item.kind === "user" ? <div>{t("这条用户消息的文字会恢复到输入框。")}</div> : null}
    {error ? <div className="gcreate-error" role="alert">{error}</div> : null}
  </DialogShell>;
}

function SaveArtifactDialog({ groupId, content, onClose }: { groupId: string; content: string; onClose: () => void }) {
  const s = useApp();
  const initial = useMemo(() => suggestArtifactTitleAndName(content, t("群聊沉淀")), [content]);
  const [title, setTitle] = useState(initial.title);
  const [filename, setFilename] = useState(initial.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const artifactsState = s.groupArtifacts?.[groupId];
  useEffect(() => {
    if (!artifactsState?.loaded && !artifactsState?.loading) {
      void loadGroupArtifacts(groupId);
    }
  }, [groupId, artifactsState?.loaded, artifactsState?.loading]);

  const existsSameName = useMemo(() => {
    const list = artifactsState?.items ?? [];
    if (!list.length || !filename.trim()) return false;
    try {
      const key = artifactNameKey(normalizeArtifactName(filename));
      return list.some((item) => artifactNameKey(item.name) === key);
    } catch {
      return false;
    }
  }, [artifactsState?.items, filename]);

  const dialogTitle = t("存为白板文档");
  const submit = async () => {
    if (busy || !filename.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveGroupArtifact(groupId, filename, { title: title.trim() || undefined, content });
      onClose();
      setNotice(t("已保存到白板「{name}」", { name: saved.name }));
      openArtifact(groupId, saved.name);
    } catch (err) {
      setError(t("保存失败：{error}", { error: err instanceof Error ? err.message : String(err) }));
      setBusy(false);
    }
  };

  return (
    <DialogShell
      label={dialogTitle}
      title={dialogTitle}
      onClose={() => { if (!busy) onClose(); }}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      actions={
        <>
          <button type="button" className="hob-btn" disabled={busy} onClick={onClose}>{t("取消")}</button>
          <button type="submit" className="hob-btn hob-btn-primary" disabled={busy || !filename.trim()}>
            {busy ? t("正在保存…") : t("保存并查看")}
          </button>
        </>
      }
    >
      <label className="gcreate-field">
        <span>{t("文档标题")}</span>
        <input
          autoFocus
          value={title}
          disabled={busy}
          placeholder={t("例如：技术方案（可选）")}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="gcreate-field">
        <span>{t("文件名称")}</span>
        <input
          required
          maxLength={80}
          value={filename}
          disabled={busy}
          placeholder={t("例如：方案.md")}
          onChange={(event) => setFilename(event.target.value)}
        />
      </label>
      {existsSameName ? (
        <div className="gcreate-note save-doc-hint">
          <Icon name="info" size={14} />
          <span>{t("已存在同名文档，保存将更新为新版本")}</span>
        </div>
      ) : null}
      {error ? <div className="gcreate-error" role="alert">{error}</div> : null}
    </DialogShell>
  );
}

function ConversationBody({ className, scrollRef, onScroll, state, scrollId, think, stick }: { className: string; scrollRef: React.RefObject<HTMLDivElement | null>; onScroll: React.UIEventHandler<HTMLDivElement>; state: ReturnType<typeof conversationState>; scrollId: string | null; think: ReturnType<typeof useLeave>; stick: { atBottom: boolean; toBottom: () => void } }) {
  const { g, a, items, empty, busy } = state;
  const s = useApp();
  const assistants = s.assistants;
  const conversation: ConversationRef | undefined = g ? { kind: "group", id: g.id } : a ? { kind: "assistant", id: a.id } : undefined;
  const [rewind, setRewind] = useState<{ conversation: ConversationRef; item: Item } | null>(null);
  const [saveDoc, setSaveDoc] = useState<{ groupId: string; text: string } | null>(null);
  const onRewind = conversation ? (item: Item) => setRewind({ conversation, item }) : undefined;
  const onSaveDoc = g
    ? (item: Item) => {
        if (item.kind === "assistant" && item.text.trim()) setSaveDoc({ groupId: g.id, text: item.text });
      }
    : a
      ? (item: Item) => {
          if (item.kind !== "assistant" || !item.text.trim()) return;
          const { name } = suggestArtifactTitleAndName(item.text, a.name);
          downloadMarkdownFile(name, item.text);
          setNotice(t("已导出「{name}」", { name }));
        }
      : undefined;
  useEffect(() => {
    setRewind(null);
    setSaveDoc(null);
  }, [conversation?.kind, conversation?.id]);
  const suggestions = think.mounted ? undefined : g?.suggestions ?? a?.suggestions;
  return <>
    <div className={className} ref={scrollRef} onScroll={onScroll}><div className={`col${empty ? " mid" : ""}`}>
      {g?.parentId ? <div className="topic-open-line">{openLine(g, assistants)}</div> : null}
      <OlderStatus id={scrollId} group={Boolean(g)} />
      {empty ? (g ? <EmptyGroup g={g} /> : a ? <EmptyChat a={a} /> : null) : g ? <GroupItemList g={g} items={items as GroupItem[]} onRewind={onRewind} onSaveDoc={onSaveDoc} /> : <ItemList items={items} onRewind={onRewind} onSaveDoc={onSaveDoc} />}
      {think.mounted && g ? <GroupThinking g={g} /> : think.mounted && a ? <Thinking a={a} leaving={think.leaving} gap={items.at(-1)?.kind === "user"} /> : g && g.queue && !g.queue.paused && g.queue.pending.length > 0 ? <GroupQueueTrail g={g} /> : null}
      <FollowUpStrip items={suggestions} group={Boolean(g)} prefix={groupSuggestionPrefix(g, items, assistants)} onPick={(text) => {
        const current = composerDraft(s).text;
        if (current.trim().length > 0) {
          setText(`${current.replace(/\s+$/, "")}\n${text}`);
          focusComposer();
          return;
        }
        setText(text);
        void send();
      }} />
    </div></div>
    <JumpToBottom show={!stick.atBottom} busy={busy} onClick={stick.toBottom} />
    {rewind && rewind.conversation.id === conversation?.id && rewind.conversation.kind === conversation.kind ? (
      <RewindDialog
        {...rewind}
        removedCount={Math.max(1, items.length - Math.max(0, items.findIndex((entry) => entry.id === rewind.item.id)))}
        onClose={() => setRewind((current) => current === rewind ? null : current)}
      />
    ) : null}
    {saveDoc && g && saveDoc.groupId === g.id ? <SaveArtifactDialog groupId={saveDoc.groupId} content={saveDoc.text} onClose={() => setSaveDoc((current) => current === saveDoc ? null : current)} /> : null}
  </>;
}

export function Chat() {
  const s = useApp();
  const { g, a, items, loaded, busy, empty, thinking } = conversationState(s);
  const parent = g?.parentId ? groupById(s, g.parentId) : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = g ? `group:${g.id}|${s.groupGen[g.id] ?? 0}` : chatKey(s.sel, s.sel ? s.itemGen[s.sel] : 0);
  const scrollId = g ? g.id : s.sel;
  const think = useLeave(thinking, 180);

  const expect = useRef(0);
  const onScroll = useOlderMessages(scrollRef, scrollId, key, items[0]?.id, expect, Boolean(g));
  const stick = useStickToBottom(scrollRef, expect, key, items.length, items[0]?.id, isMine(items.at(-1)));

  return (
    <main className="chat">
      <div className="chead">
        {s.sideCollapsed ? <button className="hob-icon-btn side-expand" title={t("展开左栏")} aria-label={t("展开左栏")} onClick={toggleSideCollapsed}><Icon name="panel" size={18} style={{ transform: "scaleX(-1)" }} /></button> : null}
        <ChatHead g={g} a={a} parent={parent} hasRightBtn={s.collapsed} />
        {s.collapsed ? (
          <button className="chead-btn right" title={t("展开右栏")} onClick={expandPanel}>
            <Icon name="panel" size={18} />
          </button>
        ) : null}
      </div>
      <ConversationBody className="msgs" scrollRef={scrollRef} onScroll={onScroll} state={{ g, a, items, loaded, busy, empty, thinking }} scrollId={scrollId} think={think} stick={stick} />
      {g?.closedAt ? <ClosedTopic g={g} /> : <Composer todos={g ? g.todos : a?.todos} jobs={runningJobs(s, items)} />}
    </main>
  );
}

/** 推荐提问：接在最后一条回复气泡下面（群里和气泡一样缩进到头像右边）。 */
function FollowUpStrip({ items, group, prefix, onPick }: { items?: string[]; group?: boolean; prefix?: string; onPick: (text: string) => void }) {
  const leave = useLeave(Boolean(items?.length), 180);
  if (!leave.mounted) return null;
  return (
    <div className={`followup-strip${group ? " in-group" : ""}${leave.leaving ? " leaving" : ""}`} role="list" aria-label={t("推荐提问")}>
      {(items ?? []).map((item) => <button className="followup-chip" key={item} role="listitem" onClick={() => onPick(`${prefix ?? ""}${item}`)}>{item}</button>)}
    </div>
  );
}

/** 输入框底部工具栏里的弹出层定位与平滑退场封装。 */
function useInlinePopover() {
  const [open, setOpen] = useState(false);
  const leave = useLeave(open, 175);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const rect = btn.current.getBoundingClientRect();
    const menuWidth = box.current?.offsetWidth || 240;
    const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
    setPos({ left: Math.max(8, Math.min(rect.left, maxLeft)), bottom: window.innerHeight - rect.top + 8 });
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !btn.current || !box.current) return;
    const rect = btn.current.getBoundingClientRect();
    const menuWidth = box.current.offsetWidth || 240;
    const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
    const nextLeft = Math.max(8, Math.min(rect.left, maxLeft));
    if (pos && Math.abs(pos.left - nextLeft) > 1) {
      setPos({ left: nextLeft, bottom: window.innerHeight - rect.top + 8 });
    }
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  return { open, setOpen, leave, btn, box, pos };
}

/** 输入框底部外露的当前模型胶囊：一眼可见当前对话模型，点开直接就地切换。 */
function ComposerModelPill({ g, a }: { g?: GroupSummary; a?: AssistantSummary }) {
  const s = useApp();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const pop = useInlinePopover();
  const settings = s.settings.settings.models;
  const rosterKey = settings.roster.map((entry) => entry.ref).join(",");
  useEffect(() => { void loadModels().then((view) => setModels(view?.models ?? null)); }, [rosterKey, s.settings.revision]);
  const roster = settings.roster.filter((entry) => models?.some((model) => model.ref === entry.ref));
  const owner = g?.parentId ? s.groups.find((item) => item.id === g.parentId) ?? g : g;
  const isTopic = Boolean(g?.parentId);
  const own = owner ? owner.models?.conversation : a?.models?.conversation;
  const activeRef = own?.ref ?? (owner ? "" : settings.conversation.ref);
  if (!activeRef && !owner) return null;
  const nameOf = (ref: string) => models?.find((model) => model.ref === ref)?.name ?? ref.split("/").pop() ?? ref;
  const followLabel = owner ? t("跟随各成员") : t("跟随全局（{name}）", { name: nameOf(settings.conversation.ref) });
  const label = own ? nameOf(own.ref) : owner ? followLabel : nameOf(settings.conversation.ref);
  const switchable = Boolean(models && roster.length > 1 && (g || a));

  const choose = async (ref: string) => {
    pop.setOpen(false);
    if (ref === (own?.ref ?? "")) return;
    const pick = ref ? { ref, thinking: fitThinking(models?.find((model) => model.ref === ref), settings.roster.find((entry) => entry.ref === ref)?.thinking ?? own?.thinking ?? settings.conversation.thinking) } : null;
    if (owner) {
      const failure = await patchGroup(owner.id, { models: { conversation: pick } });
      if (failure) setNotice(t("保存失败：{error}", { error: failure }));
      return;
    }
    if (!a) return;
    const next = { ...a.models };
    if (pick) next.conversation = pick;
    else delete next.conversation;
    await patchAssistant(a.id, { models: next });
  };

  return (
    <>
      <button
        ref={pop.btn}
        type="button"
        className={`comp-pill${pop.open ? " open" : ""}`}
        disabled={!switchable}
        title={isTopic ? t("对话模型（应用到整个群）") : t("对话模型")}
        aria-label={isTopic ? t("对话模型（应用到整个群）") : t("对话模型")}
        aria-expanded={switchable ? pop.open : undefined}
        onClick={() => switchable && pop.setOpen((v) => !v)}
      >
        <BrandIcon plain size={14} brand={brandForRef(activeRef, models ?? [], s.settings.settings.providers)} />
        <span>{label}</span>
        {switchable ? <Icon name="down" size={12} className="comp-pill-chev" /> : null}
      </button>
      {pop.leave.mounted && pop.pos ? createPortal(
        <div
          ref={pop.box}
          className={`amenu comp-pill-menu${pop.leave.leaving ? " leaving" : ""}`}
          role="menu"
          style={{ left: pop.pos.left, bottom: pop.pos.bottom, transformOrigin: "bottom left" }}
        >
          {isTopic ? <div className="comp-pill-menu-note">{t("切换后应用到整个群")}</div> : null}
          {[{ value: "", label: followLabel }, ...rosterOptions(roster, own?.ref, nameOf)].map((option) => (
            <button
              key={option.value || "follow"}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === (own?.ref ?? "")}
              className={option.value === (own?.ref ?? "") ? "sel" : undefined}
              onClick={() => void choose(option.value)}
            >
              <BrandIcon size={20} brand={brandForRef(option.value || (owner ? "" : settings.conversation.ref), models ?? [], s.settings.settings.providers)} />
              <span className="comp-pill-menu-label">{option.label}</span>
              {option.value === (own?.ref ?? "") ? <Icon name="check" size={15} /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** 群/话题输入框底部的回应模式胶囊：未点名时由谁回应，原地一键切换。 */
function ComposerReplyPill({ g }: { g: GroupSummary }) {
  const pop = useInlinePopover();
  const mode: GroupReplyMode = g.replyMode ?? "owner";
  const labels: Record<GroupReplyMode, string> = { owner: t("群主回应"), auto: t("自动选人"), all: t("全员回应") };
  const choose = async (next: GroupReplyMode) => {
    pop.setOpen(false);
    if (next === mode) return;
    const failure = await patchGroup(g.id, { replyMode: next });
    if (failure) setNotice(t("保存失败：{error}", { error: failure }));
  };
  return (
    <>
      <button
        ref={pop.btn}
        type="button"
        className={`comp-pill${pop.open ? " open" : ""}`}
        title={t("没点名时")}
        aria-label={t("没点名时")}
        aria-expanded={pop.open}
        onClick={() => pop.setOpen((v) => !v)}
      >
        <Icon name="reply" size={13} />
        <span>{labels[mode]}</span>
        <Icon name="down" size={12} className="comp-pill-chev" />
      </button>
      {pop.leave.mounted && pop.pos ? createPortal(
        <div
          ref={pop.box}
          className={`amenu comp-pill-menu${pop.leave.leaving ? " leaving" : ""}`}
          role="menu"
          style={{ left: pop.pos.left, bottom: pop.pos.bottom, transformOrigin: "bottom left" }}
        >
          {(["owner", "auto", "all"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={item === mode}
              className={item === mode ? "sel" : undefined}
              onClick={() => void choose(item)}
            >
              <span className="comp-pill-menu-label">{labels[item]}</span>
              {item === mode ? <Icon name="check" size={15} /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** 输入框上方的待办和附件都在这里排成一列。 */
export function Composer({ variant = "desktop", todos, jobs }: { variant?: "desktop"; todos?: TodoItem[]; jobs?: RunningJob[] } | { variant: "mobile"; todos?: TodoItem[]; jobs?: RunningJob[] }) {
  const s = useApp();
  const draft = composerDraft(s);
  const a = s.assistants.find((x) => x.id === s.sel);
  const g = groupById(s, s.gsel);
  const convKey = g ? `group:${g.id}` : (s.sel ?? "");
  const owner = g ? s.assistants.find((x) => x.id === g.ownerId) : undefined;
  const members = g ? membersOf(g, s.assistants) : [];
  const ta = useRef<HTMLTextAreaElement>(null);
  const compRef = useRef<HTMLDivElement>(null);
  // 光标位置要从当前文本的末尾算起（场景预填了「@」时也要直接弹出名单）
  const [caret, setCaret] = useState(draft.text.length);
  const [pick, setPick] = useState(0);
  /** Esc 关掉的那一下：这段字不再弹，改了字再弹 */
  const [muted, setMuted] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [queueBusy, setQueueBusy] = useState<"resume" | "discard" | null>(null);
  const pausedQueue = g?.queue?.paused ? g.queue.pending : null;
  /** 名单浮在输入框上面：挂在 body 上按屏幕坐标摆，不被输入框的模糊层裁掉 */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const has = draft.text.trim().length > 0 || draft.attachments.length > 0;
  const canStop = Boolean(g ? groupSpeaking(s, g).length > 0 : a?.busy);
  const quote = useLeave(draft.quote !== null, 180);
  const lastQuote = useRef(draft.quote);
  if (draft.quote) lastQuote.current = draft.quote;
  const shownQuote = draft.quote ?? (quote.mounted ? lastQuote.current : null);
  const prevConv = useRef(convKey);
  useEffect(() => {
    if (prevConv.current === convKey) return;
    prevConv.current = convKey;
    setCaret(draft.text.length);
    setPick(0);
    setMuted(null);
    setStopping(false);
    setQueueBusy(null);
  }, [convKey, draft.text.length]);
  useEffect(() => {
    if (!canStop && stopping) setStopping(false);
  }, [canStop, stopping]);
  useEffect(() => {
    if (!pausedQueue && queueBusy) setQueueBusy(null);
  }, [pausedQueue, queueBusy]);
  const handleStop = () => {
    if (stopping) return;
    setStopping(true);
    void (g ? stopGroup(g.id) : a ? stopAssistant(a.id) : Promise.resolve()).finally(() => setStopping(false));
  };
  // 群里打到 @ 就列成员：名字、职责，群主排第一
  const typing = g ? mentionAt(draft.text, caret, members.map((m) => m.name)) : null;
  const options = g && typing ? filterMembers(members, g.ownerId, typing.query) : [];
  const showing = Boolean(g && typing && options.length && muted !== draft.text);
  const mentionLeave = useLeave(showing, 160);
  const lastMention = useRef<{ anchor: { left: number; bottom: number; width: number } | null; options: AssistantSummary[] }>({ anchor: null, options: [] });
  if (showing && anchor && options.length) lastMention.current = { anchor, options };
  const active = options.length ? pick % options.length : 0;

  useLayoutEffect(() => {
    const rect = showing ? compRef.current?.getBoundingClientRect() : undefined;
    // 左边和输入框对齐，最宽不超过输入框
    const next = rect ? { left: rect.left, bottom: window.innerHeight - rect.top + 8, width: Math.min(rect.width, 320) } : null;
    setAnchor((prev) => (prev?.left === next?.left && prev?.bottom === next?.bottom && prev?.width === next?.width ? prev : next));
  }, [showing, draft.text, draft.attachments.length, variant]);

  const choose = (member: AssistantSummary | undefined) => {
    if (!typing || !member) return;
    const next = applyMention(draft.text, typing, member.name);
    setText(next.text);
    setPick(0);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    const max = variant === "mobile" ? 120 : 180;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(resize);
      }
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [draft.text, s.nonce, variant, convKey]);

  useEffect(() => {
    if (s.nonce) ta.current?.focus();
  }, [s.nonce]);

  // 截图直接粘进输入框：和「加文件」一样进附件流程，后台开始上传
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const files = pastedFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    attach(files);
  };

  // 输入框浮在消息上：量出它的高度写到 .chat 上，消息区底部照这个留白
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    const host = el?.closest<HTMLElement>(".chat");
    if (!el || !host) return;
    let frame = 0;
    const update = () => host.style.setProperty("--comp-h", `${el.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [variant]);

  const showModelPill = Boolean(s.composerModelPicker);
  const compactComposer = !g && !showModelPill;
  const textareaEl = (
    <textarea
      ref={ta}
      className="ta"
      rows={1}
      value={draft.text}
      placeholder={g ? (
        g.replyMode === "all"
          ? (g.parentId ? t("在此话题中发言，未点名时全员依次回应") : t("在综合中发言，未点名时全员依次回应"))
          : g.replyMode === "auto"
            ? (g.parentId ? t("在此话题中发言，未点名时自动选人回应") : t("在综合中发言，未点名时自动选人回应"))
          : (g.parentId ? t("在此话题中发言，未点名时由{owner}接手", { owner: sendName(owner?.name ?? "") }) : t("在综合中发言，未点名时由{owner}接手", { owner: sendName(owner?.name ?? "") }))
      ) : t("给{assistant}发消息", { assistant: sendName(a?.name ?? "") })}
      onChange={(e) => {
        setText(e.target.value);
        setCaret(e.target.selectionStart ?? e.target.value.length);
      }}
      onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
      onKeyDown={(e) => {
        if (showing) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setPick((i) => stepPick(i, 1, options.length));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setPick((i) => stepPick(i, -1, options.length));
            return;
          }
          if ((e.key === "Enter" && !e.nativeEvent.isComposing) || e.key === "Tab") {
            e.preventDefault();
            choose(options[active]);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setMuted(draft.text);
            return;
          }
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void send();
        }
      }}
    />
  );
  const sendEl = (
    <div className="comp-send">
      {/* 正在说话时始终可以叫停；同时写了草稿也不挤掉停止按钮 */}
      {canStop ? (
        <button
          className={`sendbtn stop${has ? " stop-inline" : ""}`}
          title={stopping ? t("正在停止…") : t("停止")}
          aria-label={stopping ? t("正在停止…") : t("停止")}
          disabled={stopping}
          onClick={handleStop}
        >
          {stopping ? <Icon name="spin" size={16} className="spin" /> : <Icon name="stop" size={18} />}
        </button>
      ) : null}
      {!canStop || has ? (
        <button className={`sendbtn${has ? " ready" : ""}`} title={t("发送")} aria-label={t("发送")} disabled={!has} onClick={() => void send()}>
          <Icon name="send" size={17} />
        </button>
      ) : null}
    </div>
  );

  const body = (
    <div className={`${variant === "mobile" ? "mcomp" : "comp"}${compactComposer ? " compact" : ""}`} ref={compRef} onPaste={onPaste}>
      <TodoStrip items={todos} jobs={jobs} busy={g ? g.busy.length > 0 : Boolean(a?.busy)} onOpenJob={(id) => openJob(id)} />
      {quote.mounted ? (
        <div className={`comp-quote${quote.leaving ? " leaving" : ""}`}>
          <div className="quote">{shownQuote?.text}</div>
          <button className="hob-icon-btn" style={{ width: 20, height: 20 }} onClick={() => setQuote(null)} title={t("取消引用")} aria-label={t("取消引用")}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}
      {/* 附件：图片是带 × 的缩略图，其他文件是一张小卡（图标 + 名字），和 Telegram 一样 */}
      {draft.attachments.length ? (
        <div className="comp-files">
          {draft.attachments.map((att) => {
            const path = att.path ?? localPath(att);
            const state = att.status === "uploading" ? " uploading" : att.status === "failed" ? " failed" : "";
            return isImagePath(att.name) ? (
              <span className={`comp-thumb${state}`} key={att.id}>
                <img src={photoUrl(path)} alt={att.name} role="button" tabIndex={0} title={t("查看")} onClick={() => openFilePreview(path, att.name)} onKeyDown={(e) => { if (e.key === "Enter") openFilePreview(path, att.name); }} />
                {att.status === "uploading" ? <span className="att-spin"><Icon name="spin" size={18} w={2.2} className="spin" /></span> : null}
                {att.status === "failed" ? <span className="att-bad">!</span> : null}
                <button onClick={() => removeAttachment(att.id)} title={t("移除")} aria-label={t("移除")}>
                  <Icon name="close" size={11} w={2.2} />
                </button>
              </span>
            ) : (
              <span className={`filechip${state}`} key={att.id}>
                <span className="fi">
                  {att.status === "uploading" ? <Icon name="spin" size={16} w={2.2} className="spin" /> : <Icon name={fileIcon(att.name)} size={16} />}
                </span>
                <span className="fn">{att.name}</span>
                <button onClick={() => removeAttachment(att.id)} title={t("移除")} aria-label={t("移除")}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      {mentionLeave.mounted && (showing ? anchor : lastMention.current.anchor) ? createPortal(
        <div
          className={`mention-pop${mentionLeave.leaving ? " leaving" : ""}`}
          style={{
            left: (showing ? anchor : lastMention.current.anchor)!.left,
            bottom: (showing ? anchor : lastMention.current.anchor)!.bottom,
            width: (showing ? anchor : lastMention.current.anchor)!.width,
            transformOrigin: "bottom left",
          }}
          role="listbox"
          aria-label={t("成员")}
        >
          {(showing ? options : lastMention.current.options).map((m, i) => (
            <button
              key={m.id}
              className={`mp-row${i === active ? " on" : ""}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setPick(i)}
              onClick={() => choose(m)}
            >
              <Avatar sprite={m.sprite} size={26} />
              <strong>{m.name}</strong>
              <small>{m.id === g?.ownerId ? t("群主 · {duty}", { duty: m.duty }) : m.duty}</small>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
      {pausedQueue ? (
        <div className="comp-paused" role="status">
          <span className="comp-paused-info">
            <Icon name="pause" size={15} className="comp-paused-ico" />
            <strong className="comp-paused-tag">{t("已暂停")}</strong>
            <span className="comp-paused-names">
              {pausedQueue.length
                ? queuedMembersLabel(pausedQueue, (id) => s.assistants.find((m) => m.id === id)?.name ?? id)
                : t("没有等待发言的成员")}
            </span>
          </span>
          <span className="comp-paused-acts">
            {pausedQueue.length ? (
              <button
                type="button"
                className="hob-btn hob-btn-primary comp-paused-btn"
                disabled={queueBusy !== null}
                onClick={() => {
                  if (!g || queueBusy !== null) return;
                  setQueueBusy("resume");
                  void resumeGroupQueue(g.id).finally(() => setQueueBusy(null));
                }}
              >
                {t("继续")}
              </button>
            ) : null}
            <button
              type="button"
              className="hob-btn comp-paused-btn"
              disabled={queueBusy !== null}
              onClick={() => {
                if (!g || queueBusy !== null) return;
                setQueueBusy("discard");
                void discardGroupQueue(g.id).finally(() => setQueueBusy(null));
              }}
            >
              {t("放弃")}
            </button>
          </span>
        </div>
      ) : null}
      {compactComposer ? (
        <div className="comp-main comp-compact">
          <ComposerPlus g={g} a={a} onFiles={attach} />
          {textareaEl}
          {sendEl}
        </div>
      ) : (
        <div className="comp-main comp-island">
          <div className="comp-input-row">
            {textareaEl}
          </div>
          <div className="comp-bar">
            <div className="comp-tools">
              <ComposerPlus g={g} a={a} onFiles={attach} />
              {showModelPill ? <ComposerModelPill g={g} a={a} /> : null}
              {g ? <ComposerReplyPill g={g} /> : null}
            </div>
            {sendEl}
          </div>
        </div>
      )}
    </div>
  );

  if (variant === "mobile") return <div className="mcomp-wrap" ref={wrap}>{body}</div>;
  return (
    <div className="compwrap" ref={wrap}>
      <div className="col">{body}</div>
    </div>
  );
}

/** 手机上点助手行后切到对话页。 */
export function ChatPage() {
  const s = useApp();
  const { g, a, items, loaded, busy, empty, thinking } = conversationState(s);
  const parent = g?.parentId ? groupById(s, g.parentId) : undefined;
  const think = useLeave(thinking, 180);
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = g ? `group:${g.id}|${s.groupGen[g.id] ?? 0}` : chatKey(s.sel, s.sel ? s.itemGen[s.sel] : 0);
  const scrollId = g ? g.id : s.sel;

  const expect = useRef(0);
  const onScroll = useOlderMessages(scrollRef, scrollId, key, items[0]?.id, expect, Boolean(g));
  const stick = useStickToBottom(scrollRef, expect, key, items.length, items[0]?.id, isMine(items.at(-1)));

  return (
    <>
      <div className="chead mobile">
        <button className="chead-btn left" title={t("返回")} onClick={leaveChat}>
          <Icon name="left" size={22} />
        </button>
        <ChatHead g={g} a={a} parent={parent} mobile hasRightBtn />
        <button className="chead-btn right" title={g ? t("群信息") : t("助手信息")} onClick={openSheet}>
          <Icon name="more" size={20} />
        </button>
      </div>
      <ConversationBody className="mmsgs" scrollRef={scrollRef} onScroll={onScroll} state={{ g, a, items, loaded, busy, empty, thinking }} scrollId={scrollId} think={think} stick={stick} />
      {g?.closedAt ? <ClosedTopic g={g} /> : <Composer variant="mobile" todos={g ? g.todos : a?.todos} jobs={runningJobs(s, items)} />}
    </>
  );
}
