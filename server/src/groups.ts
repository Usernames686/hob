// 群：用户和几个助手共用的时间线。@ 和引用优先，没点名时按群或话题的回应方式安排。
// 每个成员在群里有一份自己的会话，和它的单聊分开（见 docs/architecture.md「群」）。
import { t } from "../../shared/i18n.ts";
import { extractMentions } from "../../shared/mention.ts";
import type {
  Group,
  GroupItem,
  GroupItemsPage,
  GroupReplyMode,
  GroupSummary,
  JobStatus,
  NoteIcon,
  RewindResult,
  SendMessageBody,
} from "../../shared/types.ts";
import { newId } from "./ids.ts";
import { reactionsList } from "./store.ts";
import { NO_REPLY, saysNoReply, stripNoReply } from "../../shared/no-reply.ts";
import { clearTodos, hasUnfinishedWork, readTodos, releaseIdleTodos } from "./todos.ts";
import { groupTodosPath } from "./config.ts";
import { nowBlock } from "./now.ts";
import { cardHistoryLine } from "./cards.ts";
import { checkAssistantModels } from "./models.ts";
import { detectGroupControl } from "./group-control.ts";
import { decideGroupTargets } from "./group-router.ts";
import { listGroupArtifacts } from "./group-artifacts.ts";
import { rewindSession, writeRewindFiles } from "./rewind.ts";
import type { EventText, NewItem } from "./router.ts";
import type { HobRuntime } from "./runtime.ts";
import { CWD_IMMUTABLE, normalizeWorkspaceCwdInput, topicCwdLockedByGroup, validateWorkspaceCwd } from "./workspace.ts";

/** 一条用户消息引出的助手回合上限：挡来回 @ 的死循环，不是限制正常协作。 */
export const MAX_WAVE_TURNS = 20;
export const RELAY_NOTE = "群内转交次数过多，已在此暂停。";
export const RESTART_NOTE = "服务已重启，本轮已中断。";
/** 话题关了以后发消息：话题关了不能再发，能重新打开。 */
export const TOPIC_CLOSED = "这个话题已关闭，重新打开后才能发消息";
/** 用户关闭话题时没写说明就记这句；助手关闭时由调用方给出说明。 */
export const CLOSED_TOPIC_REASON = "你关闭了这个话题";
/** 群主在话题里收到的交接说明。 */
export function handoverEvent(from: string): string {
  return `这个话题是 ${from} 交给这个群的，上面是 ${from} 写的交接说明。有成品文件要交回时，先用 send_file 发到本话题。完成后用 close_topic 写结论，结论和已交付的文件会转给 ${from}，由它告诉用户。`;
}

/** 系统写的条目（停下、重启）的发言人。 */
const SYSTEM = "system";

const reviewHandover = () => "群成员已结束这一轮发言。请根据他们的回复继续处理。如果已经完成，先用 send_file 交付需要的文件，再用 close_topic 把结论交回发起助手。";

/** 结论后面附的任务记录里，任务状态怎么写。 */
const JOB_STATE: Record<JobStatus, string> = { queued: "排队中", running: "进行中", waiting: "等你回复", done: "已完成", stuck: "受阻", failed: "失败", stopped: "已停止" };

interface WaveEntry {
  assistantId: string;
  triggerId: string;
  event?: EventText;
  workDone?: boolean;
  allReplyTurn?: boolean;
  instruction?: string;
}

/** 一条消息已经排好的接力，以及这条接力用过的回合数。 */
interface WaveQueue {
  queue: WaveEntry[];
  turns: number;
  skipReview?: boolean;
}

interface Wave extends WaveQueue {
  stopped?: boolean;
  scheduled?: WaveEntry;
  finalSpeaker?: string;
  /** 全员回应：用户没点名时，群主这一串跑完后，把还没轮到过的成员按成员顺序依次排上。 */
  allReply?: {
    triggerId: string;
    participated: Set<string>;
  };
}

function canSpeak(group: Group, entry: WaveEntry): boolean {
  return group.members.includes(entry.assistantId) && (!entry.allReplyTurn || group.replyMode === "all" || group.replyMode === "auto");
}

/** 一个成员正在说的这一轮：正文（@ 检测用）、当前这条消息的条目、最后一条说成的条目、叫到它的条目。 */
interface RunningTurn {
  wave: Wave;
  calledMembers?: Set<string>;
  itemId?: string;
  /** 确认首段正文前暂存的分片。 */
  streamBuf?: string;
  lastId?: string;
  text: string;
  triggerId?: string;
  /** 事件那一轮：文字先攒着，这一轮结束再写进时间线（以 NO_REPLY 收尾就不写） */
  event?: true;
  held?: string[];
  /** 这一轮以 NO_REPLY 收尾：收到了用户消息的话，替它挂 👀 */
  silent?: boolean;
}

function needsOwnerReview(group: Group, speaker: string, turn: RunningTurn): boolean {
  return Boolean(group.handover && !group.closedAt && !group.handover.result && speaker !== group.ownerId &&
    !turn.wave.skipReview && !turn.wave.stopped && (!turn.silent || turn.lastId));
}

/** 这一轮该给它的条目，和给到哪一条（seen 存它）。 */
interface TurnInput {
  items: GroupItem[];
  seenTo?: GroupItem;
}

/** 时间线里新条目：去掉 id 和 at（由这里分配），发言人必填。 */
type NewGroupItem = NewItem & { speaker: string; forwardedFrom?: GroupItem["forwardedFrom"] };

/** 触发这一轮的消息：用户的消息，或者定时任务到点的记录。 */
export type RequestItem = Extract<GroupItem, { kind: "user" | "note" }>;

function isRequestItem(item: GroupItem | undefined): item is RequestItem {
  return item?.kind === "user" || (item?.kind === "note" && item.icon === "routine");
}

function sentFiles(item: GroupItem): string[] {
  if (item.kind === "file") return [item.path];
  return item.kind === "image" && item.status === "done" && item.path ? [item.path] : [];
}

/** 来由的文字：用户消息取原文；定时记录取到点时交给群主的全文，老数据没有 request 就取记录那一行。 */
export function requestText(item: RequestItem): string {
  return item.kind === "user" ? item.text : item.request ?? item.text;
}

export interface CreateGroupInput {
  name?: unknown;
  purpose?: unknown;
  ownerId?: unknown;
  members?: unknown;
  parentId?: unknown;
  cwd?: unknown;
  replyMode?: unknown;
}

export interface UpdateGroupInput {
  name?: unknown;
  purpose?: unknown;
  ownerId?: unknown;
  members?: unknown;
  listOrder?: unknown;
  cwd?: unknown;
  replyMode?: unknown;
}

export class GroupManager {
  /** `<gid>@<aid>` → 这个成员在这个群里的排队（同一成员同时被叫两次时排队） */
  private queues = new Map<string, Promise<void>>();
  /** `<gid>@<aid>` → 正在说的这一轮 */
  private turns = new Map<string, RunningTurn>();
  /** gid → 已经用到第几号条目 */
  private counters = new Map<string, number>();
  private activeWaves = new Map<string, Set<Wave>>();
  private pausedQueues = new Map<string, WaveQueue[]>();
  /** 成员已复核；等同一话题里其他工作结束后交回一次，接着原来的回合计数。 */
  private pendingReviews = new Map<string, number>();
  private pausing = new Map<string, Promise<void>>();
  private rewinding = new Map<string, Promise<RewindResult | undefined>>();
  /** 正在往主助手的对话送结论的话题 */
  private delivering = new Set<string>();

  constructor(private readonly runtime: HobRuntime) {
    this.repairInterrupted();
  }

  private get store() {
    return this.runtime.store;
  }

  private get bus() {
    return this.runtime.bus;
  }

  // ---------- 清单和摘要 ----------

  /** 左栏用的清单：群和话题都在里面，最近有消息的在前。 */
  list(): GroupSummary[] {
    return this.store
      .groups()
      .map((group) => this.summary(group))
      .sort((a, b) => (b.last?.at ?? b.createdAt).localeCompare(a.last?.at ?? a.createdAt));
  }

  summary(groupOrId: Group | string): GroupSummary {
    const group = typeof groupOrId === "string" ? this.group(groupOrId) : groupOrId;
    const items = this.timeline(group.id);
    const activity = this.runtime.router.groupActivity(group.id);
    const queue = this.queueOf(group.id, group);
    const artifactCount = listGroupArtifacts(this.runtime.home, group.id).length;
    let last: GroupSummary["last"];
    for (const item of items) {
      if (item.kind === "assistant" || item.kind === "user" || item.kind === "note") last = { at: item.at, speaker: item.speaker, text: item.text };
    }
    return {
      ...group,
      ...(last ? { last } : {}),
      unread: this.unread(group.id, items),
      busy: this.busyOf(group.id),
      todos: readTodos(groupTodosPath(this.runtime.home, group.id)),
      ...(this.runtime.router.suggestionsFor(group.ownerId, group.id)?.length ? { suggestions: this.runtime.router.suggestionsFor(group.ownerId, group.id) } : {}),
      ...(Object.keys(activity).length ? { activity } : {}),
      ...(queue ? { queue } : {}),
      ...(artifactCount ? { artifactCount } : {}),
    };
  }

  private queueOf(gid: string, group: Group): GroupSummary["queue"] {
    const paused = this.pausedQueues.get(gid);
    const queues = paused ?? this.waitingQueues(group);
    const pending = new Set(queues.flatMap(({ queue }) => queue.filter(entry => canSpeak(group, entry)).map(entry => entry.assistantId)));
    if (paused && this.pendingReviews.has(gid)) pending.add(group.ownerId);
    const members = [...pending].filter(id => paused || !this.turns.has(`${gid}@${id}`));
    if (paused || members.length) return { pending: members, ...(paused ? { paused: true } : {}) };
  }

  /** 这个群下面的话题（新的在前）。 */
  topicsOf(gid: string): Group[] {
    return this.store
      .groups()
      .filter((group) => group.parentId === gid)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 这个群下面没关的话题（新的在前）。 */
  activeTopics(gid: string): Group[] {
    return this.topicsOf(gid).filter((topic) => !topic.closedAt);
  }

  /** 这个群/话题是否仍有待推进的接力、自动路由、暂停波次或即将触发的群主收尾（用于避免误清共享待办）。 */
  hasPendingWork(gid: string): boolean {
    if (this.pausedQueues.has(gid) || this.pausing.has(gid) || this.pendingReviews.has(gid)) return true;
    const group = this.store.group(gid);
    for (const wave of this.activeWaves.get(gid) ?? []) {
      if (!wave.stopped && (!wave.turns || wave.scheduled || wave.queue.length || this.nextAllReplyMember(group, wave))) return true;
    }
    if (!group) return false;
    const prefix = `${gid}@`;
    for (const [key, turn] of this.turns) {
      if (!key.startsWith(prefix) || turn.wave.stopped || !this.currentWave(gid, turn.wave)) continue;
      const speakerId = key.slice(prefix.length);
      if (turn.lastId && this.mentions(turn.text, group, speakerId).length > 0) return true;
      if (needsOwnerReview(group, speakerId, turn)) return true;
    }
    return false;
  }

  /** 正在这个群里说话、或者在这个群里有任务在跑的成员。 */
  private busyOf(gid: string): string[] {
    const busy = new Set(this.runtime.router.busyMembers(gid));
    for (const job of this.store.jobs()) {
      if (job.groupId !== gid) continue;
      if (job.status === "running" || job.status === "queued" || job.status === "waiting") busy.add(job.assistantId);
    }
    return [...busy];
  }

  /** 忙闲变了推给前端（左栏小橙点、群状态行看它）。 */
  publish(gid: string): void {
    const group = this.store.group(gid);
    if (!group) return;
    this.bus.emit({ type: "group", group: this.summary(group) });
  }

  read(gid: string): void {
    this.group(gid);
    this.store.saveGroupState(gid, { readAt: new Date().toISOString() });
    this.publish(gid);
  }

  private unread(gid: string, items: GroupItem[]): number {
    const readAt = this.store.groupState(gid).readAt;
    // 从没记过已读：从现在开始算，以前的都当读过（和助手的未读一样）
    if (!readAt) {
      this.store.saveGroupState(gid, { readAt: new Date().toISOString() });
      return 0;
    }
    return items.filter((item) => item.kind === "assistant" && item.at > readAt).length;
  }

  // ---------- 建群、改群、归档 ----------

  create(input: CreateGroupInput): Group {
    // 话题是挂在群下面的群，但得先有群：建群的接口不建话题
    if (input.parentId !== undefined) throw new Error("创建群不接受 parentId：话题在群里创建（POST /api/groups/:gid/topics）。");
    const members = this.membersOf(input.members, "群里至少要有一个助手");
    const normalizedCwd = normalizeWorkspaceCwdInput(input.cwd);
    const cwd = normalizedCwd ? validateWorkspaceCwd(normalizedCwd, this.runtime.home) : undefined;
    const replyMode = this.replyModeOf(input.replyMode);
    const group: Group = {
      id: newId("g-"),
      name: this.text(input.name, "群名", 40),
      purpose: this.text(input.purpose, "职责", 200),
      ownerId: this.ownerOf(input.ownerId, members),
      members,
      ...(replyMode ? { replyMode } : {}),
      ...(cwd ? { cwd } : {}),
      createdAt: new Date().toISOString(),
    };
    this.store.saveGroup(group);
    this.note(group.id, SYSTEM, t("已创建群「{name}」", { name: group.name }), "info");
    this.publish(group.id);
    return group;
  }

  /**
   * 开一个话题：话题是挂在群下面的群，时间线、成员会话、已读都是自己的。
   * 成员、群主、负责什么取所属的群，不另存。
   */
  createTopic(gid: string, title: unknown, createdBy: string, options?: { cwd?: unknown }): Group {
    const group = this.group(gid);
    if (group.parentId) throw new Error("话题挂在群下面：话题里不能再创建话题。");
    const normalizedCwd = normalizeWorkspaceCwdInput(options?.cwd);
    let cwd: string | undefined;
    if (group.cwd) {
      if (normalizedCwd) throw new Error(topicCwdLockedByGroup(group.cwd));
    } else if (normalizedCwd) {
      cwd = validateWorkspaceCwd(normalizedCwd, this.runtime.home);
    }
    const topic: Group = {
      id: newId("g-"),
      name: this.text(title, "话题名", 40),
      purpose: group.purpose,
      ownerId: group.ownerId,
      members: group.members,
      ...(group.replyMode ? { replyMode: group.replyMode } : {}),
      ...(cwd ? { cwd } : {}),
      createdAt: new Date().toISOString(),
      parentId: gid,
      createdBy,
    };
    this.store.saveGroup(topic);
    // 综合里落一张话题卡，谁开的谁就是发言人
    this.appendItem(gid, createdBy, { kind: "topic", topicId: topic.id });
    this.publish(gid);
    this.publish(topic.id);
    return this.group(topic.id);
  }

  /**
   * 把综合里的一条用户消息复制进话题：原话、附件、引用照原样，记着它从哪来。
   * 用户和群主开话题都走这里。
   */
  forwardUserItem(gid: string, topicId: string, item: GroupItem): GroupItem | undefined {
    if (item.kind === "note" && item.icon === "routine") {
      return this.appendItem(topicId, item.speaker, { kind: "note", icon: "routine", text: item.text, ...(item.routineId ? { routineId: item.routineId } : {}), ...(item.request ? { request: item.request } : {}), forwardedFrom: { groupId: gid, itemId: item.id } });
    }
    if (item.kind !== "user") return undefined;
    return this.appendItem(topicId, "user", {
      kind: "user",
      text: item.text,
      ...(item.quote ? { quote: item.quote } : {}),
      ...(item.files?.length ? { files: item.files } : {}),
      forwardedFrom: { groupId: gid, itemId: item.id },
    });
  }

  /**
   * 任意助手把一件事交给这个群：开一个话题，把交接说明作为第一条用户条目转进去，
   * 记下是谁交来的，综合里落一行。叫醒群主由调用方发（它还要结束这一轮）。
   */
  handOver(gid: string, title: unknown, by: string, original: { text: string; files: string[]; itemId?: string; cwd?: unknown }): { topic: Group; item: GroupItem } {
    const topic = this.createTopic(gid, title, by, original.cwd !== undefined ? { cwd: original.cwd } : undefined);
    const item = this.appendItem(topic.id, "user", {
      kind: "user",
      text: original.text,
      ...(original.files.length ? { files: original.files } : {}),
      forwardedFrom: { assistantId: by, ...(original.itemId ? { itemId: original.itemId } : {}) },
    });
    this.store.saveGroup({ ...this.group(topic.id), handover: { by, at: new Date().toISOString() } });
    const byName = this.nameOf(by);
    this.note(gid, by, t("{name} 已将「{topic}」交由这个群处理", { name: byName, topic: topic.name }));
    return { topic: this.group(topic.id), item };
  }

  /** 用户或助手关闭话题：写上时间和说明；用户本人没填时用固定的关闭说明。正在跑的回合和任务不停。 */
  closeByUser(tid: string, note: unknown, by: "user" | "assistant" = "user"): Group {
    const topic = this.topic(tid);
    const text = typeof note === "string" ? note.trim() : "";
    return this.closeTopic(topic, text || (by === "user" ? t("你关闭了这个话题") : ""), text, by);
  }

  /** 群主关话题：主助手交来的，要写给用户的结论。 */
  closeByOwner(tid: string, note: unknown): Group {
    const topic = this.topic(tid);
    const text = typeof note === "string" ? note.trim() : "";
    if (topic.handover && !text) {
      const from = this.nameOf(topic.handover.by);
      throw new Error(`note 不能为空：这个话题是 ${from} 交给这个群的，结论会转给 ${from}，由它告诉用户；不做了的写明原因。`);
    }
    return this.closeTopic(topic, text, text);
  }

  /** 重新打开话题：清掉关闭说明。 */
  reopen(tid: string): Group {
    const topic = this.topic(tid);
    const { closedAt: _closedAt, closeNote: _closeNote, ...rest } = topic;
    this.store.saveGroup(rest);
    this.publish(tid);
    if (topic.parentId) this.publish(topic.parentId);
    return this.group(tid);
  }

  private closeTopic(topic: Group, note: unknown, conclusion: string, by: "user" | "assistant" = "user"): Group {
    const text = typeof note === "string" ? note.trim() : "";
    const next: Group = { ...topic, closedAt: new Date().toISOString(), ...(text ? { closeNote: text } : {}) };
    // 上一句结论还在时，这次没给说明就把它清掉，免得卡片上留着旧话
    if (!text && next.closeNote) delete next.closeNote;
    // 把结论和当时已经交付的文件一起存下来，补送时仍用这一次关闭的内容。
    if (topic.handover && !topic.handover.result) {
      const host = topic.parentId ? this.store.group(topic.parentId) : undefined;
      const groupName = host?.name ?? topic.parentId ?? "";
      const jobs = this.store.jobs().filter((job) => job.groupId === topic.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const rows = jobs.map((job) => `${job.assistantName ?? job.assistantId}「${job.title}」${JOB_STATE[job.status]}`);
      const result = conclusion
        ? `交给群「${groupName}」的话题「${topic.name}」关了。结论：${conclusion}`
        : `交给群「${groupName}」的话题「${topic.name}」被${by === "user" ? "用户" : "助手"}关了，没有写结论。`;
      const files = [...new Set([...this.store.groupItems(topic.id).flatMap(sentFiles), ...jobs.filter((job) => job.status === "done").flatMap((job) => job.files ?? [])])];
      next.handover = {
        ...topic.handover,
        result: rows.length ? `${result}\n话题里的任务：${rows.join("；")}` : result,
        ...(files.length ? { resultFiles: files } : {}),
      };
    }
    this.store.saveGroup(next);
    this.clearWaves(topic.id);
    // 关了这个话题就没人再管它的待办了：没做完的直接清掉，不再写进时间线
    const left = readTodos(groupTodosPath(this.runtime.home, topic.id));
    if (left.length) clearTodos(groupTodosPath(this.runtime.home, topic.id));
    if (next.handover?.result && !next.handover.deliveredAt) this.deliverHandover(topic.id);
    this.publish(topic.id);
    if (topic.parentId) this.publish(topic.parentId);
    return this.group(topic.id);
  }

  /** 把话题的结论送进主助手的对话；送到了记下 deliveredAt。会话条目是去重依据。 */
  private deliverHandover(tid: string): void {
    const topic = this.store.group(tid);
    const handover = topic?.handover;
    const result = handover?.result;
    if (!handover || !result || handover.deliveredAt || this.delivering.has(tid)) return;
    this.delivering.add(tid);
    void this.runtime.router.handoverResult(handover.by, tid, result, handover.resultFiles).then((received) => {
      if (!received) return;
      const current = this.store.group(tid);
      if (!current?.handover || current.handover.deliveredAt || current.handover.result !== result) return;
      this.store.saveGroup({ ...current, handover: { ...current.handover, deliveredAt: new Date().toISOString() } });
      this.runtime.delegations.topicEnded(tid, result, { files: handover.resultFiles });
    }).catch((error) => console.error("话题的结论没送到：", error)).finally(() => this.delivering.delete(tid));
  }

  /** 进程重启：记下了结论、还没送到主助手的，补送一次。 */
  recoverHandovers(): void {
    for (const group of this.store.groups()) {
      if (group.parentId && group.handover?.result && !group.handover.deliveredAt) this.deliverHandover(group.id);
    }
  }

  /** 话题不再依赖工作方式字段。旧群文件里的 workflow 由存储层原样保留。 */
  update(gid: string, patch: UpdateGroupInput): Group {
    const group = this.group(gid);
    if (patch.cwd !== undefined) throw new Error(CWD_IMMUTABLE);
    if (group.parentId) {
      return this.updateTopic(group, patch);
    }
    const members = patch.members === undefined ? group.members : this.membersOf(patch.members, "群里至少要留一个成员");
    const ownerId = patch.ownerId === undefined ? group.ownerId : this.ownerOf(patch.ownerId, members);
    if (!members.includes(ownerId)) throw new Error("群主必须是成员之一");
    const replyMode = this.replyModeOf(patch.replyMode);
    const next: Group = {
      ...group,
      members,
      ownerId,
      ...(patch.name !== undefined ? { name: this.text(patch.name, "群名", 40) } : {}),
      ...(patch.purpose !== undefined ? { purpose: this.text(patch.purpose, "职责", 200) } : {}),
      ...(replyMode !== undefined ? { replyMode } : {}),
      ...(typeof patch.listOrder === "number" && Number.isFinite(patch.listOrder) ? { listOrder: Math.max(0, Math.round(patch.listOrder)) } : {}),
    };
    if (group.memberModels) next.memberModels = Object.fromEntries(Object.entries(group.memberModels).filter(([id]) => members.includes(id)));
    this.store.saveGroup(next);
    for (const routine of this.store.routines()) {
      const destination = routine.groupId ? this.store.group(routine.groupId) : undefined;
      if (!destination || (destination.parentId ?? destination.id) !== gid || routine.assistantId === ownerId) continue;
      this.runtime.routines.transfer(routine, ownerId);
    }
    const topicIds = this.topicsOf(gid).map((topic) => topic.id);
    // 被移出的成员在各话题里的会话也跟着放掉
    for (const id of group.members) if (!members.includes(id)) this.forgetMemberSessions([gid, ...topicIds], id);
    // 换了群主：两边重开会话，群主工具和提示词才跟着换
    if (ownerId !== group.ownerId) for (const id of [group.ownerId, ownerId]) this.forgetMemberSessions([gid, ...topicIds], id);
    this.publish(gid);
    for (const topic of this.topicsOf(gid)) this.publish(topic.id);
    return next;
  }

  /** 保存本群的模型覆盖，话题共用所属群的设置。 */
  async updateModels(gid: string, patch: unknown): Promise<Group> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("模型设置无效");
    await this.runtime.models.get();
    const selected = this.group(gid);
    const group = selected.parentId ? this.group(selected.parentId) : selected;
    const models = this.modelPatch(group.models, patch as Record<string, unknown>);
    const next = { ...group, models };
    this.store.saveGroup(next);
    const ids = [group.id, ...this.topicsOf(group.id).map((topic) => topic.id)];
    for (const id of group.members) this.runtime.router.releaseGroupMemberSessions(id, ids);
    for (const id of ids) this.publish(id);
    return next;
  }

  /** 保存一个成员在所属群的模型覆盖。 */
  async updateMemberModels(gid: string, assistantId: string, patch: Record<string, unknown>): Promise<Group> {
    await this.runtime.models.get();
    const selected = this.group(gid);
    const group = selected.parentId ? this.group(selected.parentId) : selected;
    if (!group.members.includes(assistantId)) throw new Error("助手不是这个群的成员");
    const models = this.modelPatch(group.memberModels?.[assistantId], patch);
    const memberModels = { ...group.memberModels };
    if (models.conversation || models.work) memberModels[assistantId] = models;
    else delete memberModels[assistantId];
    const next = { ...group, memberModels };
    this.store.saveGroup(next);
    this.runtime.router.releaseGroupMemberSessions(assistantId, [group.id, ...this.topicsOf(group.id).map((topic) => topic.id)]);
    this.publish(group.id);
    for (const topic of this.topicsOf(group.id)) this.publish(topic.id);
    return next;
  }

  private modelPatch(current: Group["models"], patch: Record<string, unknown>): NonNullable<Group["models"]> {
    const models = { ...current };
    for (const key of ["conversation", "work"] as const) {
      if (!(key in patch)) continue;
      if (patch[key] === null) delete models[key];
      else {
        const checked = checkAssistantModels({ models: { [key]: patch[key] } as never }, this.runtime.settings.settings.models.roster, this.runtime.models).models?.[key];
        if (!checked) throw new Error("模型设置无效");
        models[key] = checked;
      }
    }
    return models;
  }

  /** 话题只能改名和回应方式：成员、群主、负责什么跟着所属的群。 */
  private updateTopic(topic: Group, patch: UpdateGroupInput): Group {
    if (patch.cwd !== undefined) throw new Error(CWD_IMMUTABLE);
    if (patch.members !== undefined || patch.ownerId !== undefined || patch.purpose !== undefined) {
      throw new Error("话题的成员、群主与职责随所属的群，请在群设置中修改。");
    }
    const replyMode = this.replyModeOf(patch.replyMode);
    const next: Group = {
      ...topic,
      ...(patch.name !== undefined ? { name: this.text(patch.name, "话题名", 40) } : {}),
      ...(replyMode !== undefined ? { replyMode } : {}),
    };
    this.store.saveGroup(next);
    this.publish(topic.id);
    if (topic.parentId) this.publish(topic.parentId);
    return next;
  }

  private forgetMemberSessions(groupIds: string[], assistantId: string): void {
    for (const gid of groupIds) this.runtime.router.forgetSession(assistantId, gid);
  }

  /** 结束这个群：先停下正在说话的成员，整个群目录连同各话题一起搬进 archive/groups/。 */
  async archive(gid: string): Promise<void> {
    const group = this.group(gid);
    if (group.parentId) throw new Error("话题用关闭，不用归档");
    const topics = this.topicsOf(gid);
    await this.stop(gid, group);
    for (const topic of topics) await this.stop(topic.id, topic);
    this.runtime.router.forgetGroup(gid);
    for (const topic of topics) this.runtime.router.forgetGroup(topic.id);
    for (const routine of this.store.routines()) {
      const target = routine.groupId ? this.store.group(routine.groupId) : undefined;
      if (target && (target.parentId ?? target.id) === gid && routine.active) this.runtime.routines.update(routine.id, { active: false });
    }
    this.store.archiveGroup(gid, `${gid}-${new Date().toISOString().replace(/[:.]/g, "-")}`, topics.map((topic) => topic.id));
    this.runtime.routines.reload();
    for (const id of [gid, ...topics.map((topic) => topic.id)]) {
      this.counters.delete(id);
      this.clearWaves(id);
    }
    this.bus.emit({ type: "group_removed", id: gid });
    for (const topic of topics) this.bus.emit({ type: "group_removed", id: topic.id });
  }

  /** 助手归档了：从它所在的群里移出；它是群主就换剩下的第一个成员；群里没人了就把群一起归档。 */
  async assistantArchived(assistantId: string): Promise<void> {
    for (const group of this.store.groups()) {
      // 话题的成员跟着所属的群：群处理完，话题跟着变
      if (group.parentId) continue;
      if (!group.members.includes(assistantId)) continue;
      const members = group.members.filter((id) => id !== assistantId);
      if (!members.length) {
        await this.archive(group.id);
        continue;
      }
      const ownerId = group.ownerId === assistantId ? members[0]! : group.ownerId;
      this.update(group.id, { members, ownerId });
      this.forgetMemberSessions([group.id, ...this.topicsOf(group.id).map((topic) => topic.id)], assistantId);
      this.note(group.id, SYSTEM, t("「{name}」已归档，并移出此群", { name: this.nameOf(assistantId) }), "info");
      this.publish(group.id);
      for (const topic of this.topicsOf(group.id)) this.publish(topic.id);
    }
  }

  private topic(id: string): Group {
    const group = this.group(id);
    if (!group.parentId) throw new Error("关闭和重新打开仅适用于话题；群请使用归档。");
    return group;
  }

  private text(value: unknown, label: string, max: number): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
    const text = value.trim();
    if ([...text].length > max) throw new Error(`${label}最多 ${max} 字`);
    return text;
  }

  /** members 里至少要有一个助手；空了就抛 tooFew（建群和改群的说法不一样）。 */
  private membersOf(value: unknown, tooFew: string): string[] {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) throw new Error("成员必须是助手 ID 的列表");
    const ids = [...new Set(value as string[])];
    if (!ids.length) throw new Error(tooFew);
    for (const id of ids) {
      if (!this.store.assistant(id)) throw new Error(`助手不存在或已归档：${id}`);
    }
    return ids;
  }

  private ownerOf(value: unknown, members: string[]): string {
    if (value === undefined) throw new Error("群主不能为空");
    if (typeof value !== "string" || !value) throw new Error("群主须填写助手 ID");
    if (!members.includes(value)) throw new Error("群主必须是成员之一");
    return value;
  }

  private replyModeOf(value: unknown): GroupReplyMode | undefined {
    if (value === undefined) return undefined;
    if (value === "owner" || value === "all" || value === "auto") return value;
    throw new Error(`回应方式只能填 owner、all 或 auto，收到「${String(value)}」`);
  }

  // ---------- 群里的消息 ----------

  /** 用户在群里说话：写一条 user 条目，算出轮到谁，给每个人开一轮。话题关了就不收，等重新打开。 */
  async send(gid: string, body: SendMessageBody): Promise<GroupItem> {
    while (this.rewinding.has(gid) || this.pausing.has(gid)) await (this.rewinding.get(gid) ?? this.pausing.get(gid));
    let group = this.group(gid);
    if (group.closedAt) throw new Error(TOPIC_CLOSED);
    const control = !body.quote && !body.files?.length ? detectGroupControl(body.text) : null;
    const active = this.activeWaves.get(gid);
    const paused = this.pausedQueues.get(gid);
    this.runtime.router.clearSuggestions(group.ownerId, gid);
    const item = this.append(gid, {
      kind: "user",
      speaker: "user",
      text: body.text,
      ...(body.quote ? { quote: body.quote } : {}),
      ...(body.files?.length ? { files: body.files } : {}),
    });
    this.bus.emit({ type: "group-item", groupId: gid, item });
    this.publish(gid);

    if (control === "pause" && (active || paused || this.pendingReviews.has(gid))) {
      const remaining = [...(paused ?? []), ...this.waitingQueues(group)];
      const canResume = remaining.length > 0 || this.pendingReviews.has(gid);
      if (canResume) this.pausedQueues.set(gid, remaining);
      this.activeWaves.delete(gid);
      if (!paused) this.note(gid, SYSTEM, canResume ? t("已暂停，回复「继续」从下一位接着走") : t("已暂停"), "info");
      if (active) {
        const stopping = this.interruptMembers(group).finally(() => this.pausing.delete(gid));
        this.pausing.set(gid, stopping);
        await stopping;
      } else this.publish(gid);
      if (!canResume) releaseIdleTodos(this.runtime, group.ownerId, gid);
      return item;
    }
    if (control === "resume" && paused) {
      if (!await this.resumeQueue(gid)) this.note(gid, SYSTEM, t("没有等待发言的成员"), "info");
      return item;
    }
    if (this.pausedQueues.delete(gid)) this.pendingReviews.delete(gid);

    const explicit = this.explicitTargetsOf(group, body.text, body.quote);
    let targets = explicit.length ? explicit : [group.ownerId];
    let all = !explicit.length && group.replyMode === "all";
    let approvalsBeforeRouting: Set<string> | undefined;
    if (!explicit.length && group.replyMode === "auto") {
      approvalsBeforeRouting = new Set(this.store.approvals().filter(a => a.groupId === gid && a.status === "pending").map(a => a.id));
      // 空波次只标记选人仍有效，结果回来后才创建成员队列。
      const selection = this.newWave(gid);
      if (paused) this.publish(gid);
      const decision = await decideGroupTargets(this.runtime, group, item);
      if (!this.forgetWave(gid, selection)) return item;
      group = this.group(gid);
      all = decision.all;
      const selected = decision.targets.filter((id) => group.members.includes(id));
      targets = all || decision.fallback || !selected.length ? [group.ownerId] : selected;
    }
    this.expireApprovals(gid, all ? group.members : targets, approvalsBeforeRouting);
    const wave = this.newWave(gid, { queue: targets.map(assistantId => ({ assistantId, triggerId: item.id })) });
    if (all) wave.allReply = { triggerId: item.id, participated: new Set() };
    this.advanceWave(gid, wave, group);
    return item;
  }

  private expireApprovals(gid: string, recipients?: string[], pendingBeforeRouting?: Set<string>): void {
    // 点名或自动选人时，只结束本次收件人在消息发来时已提出的问题。
    for (const approval of this.store.approvals()) {
      if (approval.groupId !== gid || approval.source !== "router" || approval.status !== "pending") continue;
      if (recipients && !recipients.includes(approval.assistantId)) continue;
      if (pendingBeforeRouting && !pendingBeforeRouting.has(approval.id)) continue;
      const expired = { ...approval, status: "expired" as const };
      this.store.saveApproval(expired);
      this.bus.emit({ type: "approval", approval: expired });
    }
  }

  private clearWaves(gid: string): void {
    this.activeWaves.delete(gid);
    this.pausedQueues.delete(gid);
    this.pendingReviews.delete(gid);
  }

  /** 停掉这个群里所有成员正在进行的回合（不停任务）；排队里的回合也不再生效。 */
  async stop(gid: string, group = this.group(gid)): Promise<void> {
    this.clearWaves(gid);
    this.runtime.router.clearSuggestions(group.ownerId, gid);
    await this.interruptMembers(group);
  }

  private async interruptMembers(group: Group): Promise<void> {
    const gid = group.id;
    const members = new Set(group.members);
    const turns = [...this.turns].filter(([key]) => key.startsWith(`${gid}@`));
    const queues = [...this.queues].filter(([key]) => key.startsWith(`${gid}@`));
    for (const [key, turn] of turns) {
      members.add(key.slice(gid.length + 1));
      if (turn.event) this.turns.delete(key);
    }
    await Promise.all([...members].map((id) => this.runtime.router.stop(id, gid)));
    for (const [key, turn] of turns) if (this.turns.get(key) === turn) this.turns.delete(key);
    for (const [key, queue] of queues) if (this.queues.get(key) === queue) this.queues.delete(key);
    this.publish(gid);
  }

  async resumeQueue(gid: string): Promise<boolean> {
    while (this.rewinding.has(gid) || this.pausing.has(gid)) await (this.rewinding.get(gid) ?? this.pausing.get(gid));
    const group = this.group(gid);
    if (group.closedAt) throw new Error(TOPIC_CLOSED);
    const paused = this.pausedQueues.get(gid);
    if (!paused) return false;
    this.pausedQueues.delete(gid);
    let resumed = this.pendingReviews.has(gid);
    for (const saved of paused) {
      const queue = saved.queue.filter(entry => canSpeak(group, entry));
      if (!queue.length) continue;
      this.advanceWave(gid, this.newWave(gid, { ...saved, queue }));
      resumed = true;
    }
    this.reviewWhenIdle(gid);
    if (!this.activeWaves.has(gid)) releaseIdleTodos(this.runtime, group.ownerId, gid);
    this.publish(gid);
    return resumed;
  }

  async discardQueue(gid: string): Promise<boolean> {
    while (this.rewinding.has(gid) || this.pausing.has(gid)) await (this.rewinding.get(gid) ?? this.pausing.get(gid));
    const group = this.group(gid);
    const had = this.pausedQueues.delete(gid);
    if (had) {
      this.pendingReviews.delete(gid);
      if (!this.activeWaves.has(gid)) releaseIdleTodos(this.runtime, group.ownerId, gid);
      this.publish(gid);
    }
    return had;
  }

  async rewind(gid: string, beforeItemId: string): Promise<RewindResult | undefined> {
    while (this.rewinding.has(gid) || this.pausing.has(gid)) await (this.rewinding.get(gid) ?? this.pausing.get(gid));
    const group = this.store.group(gid);
    const cutItem = group && this.timeline(gid).find((item) => item.id === beforeItemId);
    if (!group || !cutItem) return undefined;
    const work = Promise.resolve().then(async () => {
      await this.stop(gid, group);
      const all = this.timeline(gid);
      const cut = all.findIndex((item) => item.id === beforeItemId);
      if (cut < 0) return undefined;
      const kept = all.slice(0, cut);
      const keptIds = new Set(kept.map(({ id }) => id));
      const stored = this.store.groupItems(gid);
      this.counters.set(gid, this.lastItemNumber(gid, stored));
      const state = this.store.groupState(gid);
      const last = kept.at(-1);
      const changes: { file: string; lines: unknown[] }[] = [{ file: this.store.groupTimelineFile(gid), lines: stored.filter(({ id }) => keptIds.has(id)) }];
      const memberLastTs = new Map<string, string | undefined>();
      for (const { assistantId, file } of this.store.groupMemberFiles(gid)) {
        const result = rewindSession(file, cutItem.at);
        memberLastTs.set(assistantId, result.lastTimestamp);
        if (result.change) changes.push(result.change);
      }
      const seen: Record<string, string> = {};
      for (const [id, itemId] of Object.entries(state.seen ?? {})) {
        let seenTo: string | undefined;
        if (keptIds.has(itemId)) {
          seenTo = itemId;
        } else if (memberLastTs.has(id)) {
          const lastTs = memberLastTs.get(id);
          seenTo = kept.findLast((item) => item.speaker === id || (lastTs !== undefined && item.at <= lastTs))?.id;
        } else {
          seenTo = last?.id;
        }
        if (seenTo) seen[id] = seenTo;
      }
      const reactions = Object.fromEntries(Object.entries(state.reactions ?? {}).filter(([id]) => keptIds.has(id)));
      this.runtime.router.forgetGroup(gid);
      writeRewindFiles(changes, () => this.store.saveGroupState(gid, {
        seen, reactions, ...(state.readAt && (!last || state.readAt > last.at) ? { readAt: last?.at } : {}),
      }));
      this.expireApprovals(gid);
      this.bus.emit({ type: "conversation-rewound", target: "group", id: gid });
      this.publish(gid);
      return { ok: true as const, removedCount: all.length - cut, ...(cutItem.kind === "user" ? { restoredText: cutItem.text } : {}) };
    }).finally(() => this.rewinding.delete(gid));
    this.rewinding.set(gid, work);
    return work;
  }

  /** 用户的消息明确点名了谁：@ 了谁、引用谁的消息就是谁。 */
  private explicitTargetsOf(group: Group, text: string, quote?: { itemId: string; text: string }): string[] {
    const out = this.mentions(text, group);
    if (quote) {
      const quoted = this.store.groupItems(group.id).find((item) => item.id === quote.itemId);
      const speaker = quoted?.speaker;
      if (speaker && speaker !== "user" && speaker !== SYSTEM && group.members.includes(speaker) && !out.includes(speaker)) out.push(speaker);
    }
    return out;
  }

  /** 用户的消息轮到谁：@ 了谁、引用谁的消息就是谁；都没有就轮到群主。 */
  targetsOf(group: Group, text: string, quote?: { itemId: string; text: string }): string[] {
    const out = this.explicitTargetsOf(group, text, quote);
    return out.length ? out : [group.ownerId];
  }

  /** @ 名字或成员 ID：按长名称优先匹配（支持全角 ＠ 和带空格的名字）；跳过代码块与邮箱/英文前缀误触发。 */
  private mentions(text: string, group: Group, exclude?: string): string[] {
    return extractMentions(text, group.members.map((id) => ({ id, name: this.nameOf(id), aliases: [id] }))).filter((id) => id !== exclude);
  }

  private newWave(gid: string, plan: Partial<WaveQueue> = {}): Wave {
    const wave: Wave = { queue: [], turns: 0, ...plan };
    const active = this.activeWaves.get(gid) ?? new Set<Wave>();
    active.add(wave);
    this.activeWaves.set(gid, active);
    return wave;
  }

  private currentWave(gid: string, wave: Wave): boolean {
    return this.activeWaves.get(gid)?.has(wave) ?? false;
  }

  private forgetWave(gid: string, wave: Wave): boolean {
    const active = this.activeWaves.get(gid);
    if (!active?.delete(wave)) return false;
    if (!active.size) this.activeWaves.delete(gid);
    return true;
  }

  /** 暂停和摘要共用这份名单，只取已经确定、还没开始的成员。 */
  private waitingQueues(group: Group): WaveQueue[] {
    const waiting: WaveQueue[] = [];
    for (const wave of this.activeWaves.get(group.id) ?? []) {
      if (wave.stopped) continue;
      const queue = wave.scheduled && wave.scheduled.event !== reviewHandover ? [wave.scheduled, ...wave.queue] : [...wave.queue];
      if (wave.allReply && (group.replyMode === "all" || group.replyMode === "auto")) {
        const selected = new Set([...wave.allReply.participated, ...queue.map(entry => entry.assistantId)]);
        for (const assistantId of group.members) {
          if (!selected.has(assistantId)) queue.push({ assistantId, triggerId: wave.allReply.triggerId, allReplyTurn: true });
        }
      }
      if (queue.length) waiting.push({ queue, turns: wave.turns, skipReview: wave.skipReview });
    }
    return waiting;
  }

  private nextAllReplyMember(group: Group | undefined, wave: Wave): string | undefined {
    const allReply = wave.allReply;
    if ((group?.replyMode === "all" || group?.replyMode === "auto") && allReply) {
      return group.members.find((id) => !allReply.participated.has(id));
    }
  }

  /** 给一个成员排一轮：同一成员同时被叫两次时排队，第二次的输入包含第一次之后的新条目。 */
  private schedule(gid: string, wave: Wave, entry: WaveEntry): Promise<void> {
    const key = `${gid}@${entry.assistantId}`;
    wave.scheduled = entry;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => {
        delete wave.scheduled;
        return this.runTurn(gid, wave, entry);
      })
      .catch(() => undefined)
      .finally(() => this.advanceWave(gid, wave));
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  /**
   * 这一串里正在跑的回合都结束时收尾：
   * 全员回应的波次还有没轮到的成员，就按成员列表顺序排上下一个（前一个跑完才轮到下一个）；
   * 全部跑完后再生成推荐提问。
   */
  private advanceWave(gid: string, wave: Wave, steerGroup?: Group): void {
    if (!this.currentWave(gid, wave)) return;
    if (!wave.stopped) {
      let entry = wave.queue.shift();
      if (!entry) {
        const group = this.store.group(gid);
        const nextMember = this.nextAllReplyMember(group, wave);
        if (nextMember && wave.allReply) entry = { assistantId: nextMember, triggerId: wave.allReply.triggerId, allReplyTurn: true };
      }
      if (entry) {
        if (steerGroup) void this.callTurn(gid, steerGroup, wave, entry);
        else void this.schedule(gid, wave, entry);
        this.publish(gid);
        return;
      }
      if (!this.pendingReviews.has(gid) && wave.finalSpeaker) void this.runtime.router.generateSuggestionsFor(wave.finalSpeaker, gid);
    }
    this.forgetWave(gid, wave);
    this.reviewWhenIdle(gid);
    this.publish(gid);
  }

  private reviewWhenIdle(gid: string): void {
    const turns = this.pendingReviews.get(gid);
    if (turns === undefined || this.activeWaves.has(gid) || this.pausedQueues.has(gid)) return;
    const group = this.store.group(gid);
    if (!group || hasUnfinishedWork(this.runtime, group.ownerId, gid)) return;
    void this.schedule(gid, this.newWave(gid, { turns }), { assistantId: group.ownerId, triggerId: "", event: reviewHandover });
  }

  /**
   * 用户叫到一个成员：它正在这个群里说一轮，就把新条目用 steer 插进那一轮，不另排一轮；
   * 会话刚好跑完（没在流式）就照原来的路子排队。
   */
  private async callTurn(gid: string, group: Group, wave: Wave, entry: WaveEntry): Promise<void> {
    const { assistantId, triggerId } = entry;
    const key = `${gid}@${assistantId}`;
    const runningTurn = this.turns.get(key);
    const input = runningTurn && this.currentWave(gid, runningTurn.wave) ? this.windowFor(group, assistantId, triggerId) : undefined;
    if (runningTurn && input) {
      const text = this.inputText(assistantId, group, input);
      // 会话刚好收掉（不在流式、或者 abort 了）：照原来的路子排队，话不会丢
      const received = () => {
        if (!this.currentWave(gid, runningTurn.wave)) return;
        delete wave.scheduled;
        this.markSeen(gid, assistantId, input.seenTo);
        // 插进的是事件那一轮：从用户这条起是回用户的话，前面攒着的先收尾，之后照常边写边推（和单聊一致）
        if (this.turns.get(key) === runningTurn && runningTurn.event) {
          this.settleEventTurn(gid, assistantId, runningTurn);
          delete runningTurn.event;
        }
      };
      const running = this.queues.get(key);
      wave.scheduled = entry;
      const steered = await this.runtime.router.steerMember(gid, assistantId, text, this.inputFiles(input), received).catch(() => false);
      delete wave.scheduled;
      if (steered) {
        if (!this.currentWave(gid, wave)) return;
        const active = runningTurn.wave;
        // 新消息插进同一轮，后面的点名也跟进原队列；这轮回复里点名的新成员仍能先接力。
        if (this.turns.get(key) === runningTurn && !active.stopped) {
          active.queue.push(...wave.queue);
          active.allReply ??= wave.allReply;
          active.allReply?.participated.add(assistantId);
          this.forgetWave(gid, wave);
          this.publish(gid);
          return;
        }
        wave.allReply?.participated.add(assistantId);
        await running;
        return this.advanceWave(gid, wave);
      }
    }
    if (this.currentWave(gid, wave)) await this.schedule(gid, wave, entry);
  }

  /**
   * 任务结果、审批答案这类事件送进这个成员在群里的会话：和用户叫到它一样排进它的队列、
   * 开一轮（不然流式的文字没有归属，会被丢掉），它说的话照常进时间线。
   * 一个事件算新的一串回合（新的 Wave）。
   */
  async deliverEvent(gid: string, assistantId: string, text: EventText, triggerId = "", workDone = false): Promise<void> {
    while (this.rewinding.has(gid)) await this.rewinding.get(gid);
    const group = this.group(gid);
    if (!group.members.includes(assistantId)) return;
    const wave = this.newWave(gid);
    await this.schedule(gid, wave, { assistantId, triggerId, event: text, workDone });
  }

  /**
   * 这一轮是谁叫到它的：用户的消息、别的成员的回复，或者一个事件（事件没有触发条目）。
   * 开话题时用它取「叫到群主的那条用户消息」。
   */
  triggerOf(gid: string, assistantId: string): GroupItem | undefined {
    const id = this.turns.get(`${gid}@${assistantId}`)?.triggerId;
    return id ? this.store.groupItems(gid).find((item) => item.id === id) : undefined;
  }

  /**
   * 这一轮的来由：触发这一轮的条目是用户消息或定时到点记录，就是它；
   * 否则取时间线上最近的一条用户消息或定时到点记录（开话题时转过去的话都照这个取）。
   */
  requestItem(gid: string, assistantId: string): RequestItem | undefined {
    const trigger = this.triggerOf(gid, assistantId);
    if (isRequestItem(trigger)) return trigger;
    return this.timeline(gid).findLast(isRequestItem);
  }

  enqueueMembers(gid: string, ownerId: string, members: string[], options: { note?: string; returnToOwner?: boolean }): boolean {
    const turn = this.turns.get(`${gid}@${ownerId}`);
    if (!turn || !this.currentWave(gid, turn.wave) || turn.wave.stopped) throw new Error("当前没有可安排接力的群主回合。");
    const triggerId = turn.lastId ?? turn.triggerId ?? "";
    const entries = members.map((assistantId, index) => ({
      assistantId,
      triggerId,
      instruction: `群主点名你按顺序发言（第 ${index + 1}/${members.length} 位）。${options.note ? `交代：${options.note}` : "请结合上方群聊内容发言。"}`,
    }));
    const topic = this.group(gid);
    const handedOver = Boolean(topic.handover && !topic.handover.result && !topic.closedAt);
    const returnToOwner = options.returnToOwner ?? handedOver;
    if (handedOver) {
      turn.wave.skipReview = !returnToOwner;
    } else if (returnToOwner && entries.at(-1)?.assistantId !== ownerId) {
      entries.push({ assistantId: ownerId, triggerId, instruction: "你安排的成员已依次发言完毕，请结合他们的回复进行总结收口。" });
    }
    const called = turn.calledMembers ??= new Set<string>();
    for (const entry of entries) called.add(entry.assistantId);
    const batch = new Set(entries.map((entry) => entry.assistantId));
    turn.wave.queue = [...entries, ...turn.wave.queue.filter((entry) => !batch.has(entry.assistantId))];
    this.publish(gid);
    return returnToOwner;
  }

  private async runTurn(gid: string, wave: Wave, entry: WaveEntry): Promise<void> {
    const { assistantId, triggerId, event, instruction, workDone = false, allReplyTurn = false } = entry;
    const group = this.store.group(gid);
    if (!group) return;
    // 用户按了停止：这一轮不再开始
    if (!this.currentWave(gid, wave)) return;
    if (event === reviewHandover) {
      if (!this.pendingReviews.has(gid) || group.ownerId !== assistantId ||
          this.activeWaves.get(gid)!.size > 1 || hasUnfinishedWork(this.runtime, assistantId, gid)) return;
    }
    if (!canSpeak(group, entry)) return;
    wave.allReply?.participated.add(assistantId);
    wave.queue = wave.queue.filter(entry => !entry.allReplyTurn || entry.assistantId !== assistantId);
    // 一条用户消息引出的 @ 接力回合太多：停下，不再按 @ 叫人；全员依次轮到的回合每人最多一次，不受此上限截断
    if (!allReplyTurn && wave.turns >= MAX_WAVE_TURNS) {
      if (!wave.stopped) {
        wave.stopped = true;
        this.note(gid, SYSTEM, RELAY_NOTE, "info");
        // 群主在群里收尾：只给它这一轮，它再 @ 人也不接着转，免得停了又起
        const wrapUp = this.newWave(gid);
        wrapUp.stopped = true;
        void this.schedule(gid, wrapUp, {
          assistantId: group.ownerId, triggerId: "",
          event: `${RELAY_NOTE}：一条消息引出的助手回复已经超过 ${MAX_WAVE_TURNS} 轮，后面的 @ 不再转给下一个成员。需要的话，把结论整理一下再发一条。`,
        });
      }
      return;
    }
    // 排到的这一轮已经没有新东西给它（前面那一轮已经带上了）：不跑，不调模型
    const input = this.windowFor(group, assistantId, event === undefined ? triggerId : "");
    if (event === undefined && !instruction && !input) return;
    if (assistantId === group.ownerId) {
      this.pendingReviews.delete(gid);
      if (this.pausedQueues.get(gid)?.length === 0) this.pausedQueues.delete(gid);
    }
    if (!allReplyTurn) wave.turns += 1;
    const key = `${gid}@${assistantId}`;
    const turn: RunningTurn = { wave, text: "", ...(event !== undefined ? { event: true as const, held: [] } : {}), ...(triggerId ? { triggerId } : {}) };
    this.turns.set(key, turn);
    this.publish(gid);
    const isCurrent = () => this.currentWave(gid, wave);
    let failed = false;
    try {
      const prompt = this.inputText(assistantId, group, input ?? { items: [] }, event);
      await this.runtime.router.deliverMember(gid, assistantId, instruction ? `${prompt}\n\n${instruction}` : prompt, () => {
        if (isCurrent()) this.markSeen(gid, assistantId, input?.seenTo);
      }, input ? this.inputFiles(input) : [], event === undefined || workDone, isCurrent);
      // 已开口的事件回合在关闭话题后仍可写完，后续接力由波次控制。
      if (turn.event && this.turns.get(key) === turn) this.settleEventTurn(gid, assistantId, turn);
    } catch (error) {
      failed = true;
      if (!isCurrent()) return;
      // 中途出错：没说到 NO_REPLY，已经写好的那几段照常出（和单聊一致），再写失败原因
      if (turn.event) this.settleEventTurn(gid, assistantId, turn);
      const message = error instanceof Error ? error.message : String(error);
      this.note(gid, assistantId, t("回复失败：{error}。@{name} 发送一条消息即可重试。", { error: message, name: this.nameOf(assistantId) }), "info");
    } finally {
      if (this.turns.get(key) === turn) this.turns.delete(key);
    }
    if (!isCurrent()) return;
    if (!failed && needsOwnerReview(group, assistantId, turn)) {
      this.pendingReviews.set(gid, Math.max(this.pendingReviews.get(gid) ?? 0, wave.turns));
    }
    // 这一轮收到了用户的消息、回了 NO_REPLY、自己也没点表情：替它挂 👀，用户看得出消息到了
    const userItem = input?.items.findLast((item) => item.kind === "user");
    if (userItem && turn.silent && !turn.lastId && !this.store.groupState(gid).reactions?.[userItem.id]?.[assistantId]) this.react(gid, assistantId, "👀", userItem.id);
    // 回复里 @ 了别的成员：接着轮到他们（用这一轮最后一条的 id 当触发条目）
    if (!turn.lastId) return;
    wave.finalSpeaker = assistantId;
    if (wave.stopped) return;
    const waiting = new Set(wave.queue.filter(entry => !entry.allReplyTurn).map(entry => entry.assistantId));
    const relay = this.mentions(turn.text, group, assistantId)
      .filter((id) => !waiting.has(id) && !turn.calledMembers?.has(id))
      .map((assistantId) => ({ assistantId, triggerId: turn.lastId! }));
    wave.queue.unshift(...relay);
  }

  /**
   * 这一轮该给它的条目：时间线里它上次说完以后的新条目；叫它的那条在那些条目之前
   * （排队等的时候又来了新的）就补在最后，模型才看得到是谁叫的。
   * 没有新条目、叫它的那条也给过了 → 返回 undefined，这一轮不用跑。
   */
  private windowFor(group: Group, assistantId: string, triggerId: string): TurnInput | undefined {
    const items = this.timeline(group.id);
    // 上一轮给到的最后一条记在 state.json：只调了工具没说话的回合，下一轮（重启后也一样）不重复给
    const seen = this.store.groupState(group.id).seen ?? {};
    const lastOwn = items.findLastIndex((item) => item.kind === "assistant" && item.speaker === assistantId);
    const seenAt = seen[assistantId] ? items.findIndex((item) => item.id === seen[assistantId]) : -1;
    const window = items.slice(Math.max(lastOwn, seenAt) + 1);
    const trigger = triggerId ? items.find((item) => item.id === triggerId) : undefined;
    if (!window.length) return undefined;
    const input = trigger && !window.some((item) => item.id === trigger.id) ? [...window, trigger] : window;
    return { items: input, seenTo: items.at(-1) };
  }

  /**
   * 这一轮的输入：这些条目按「名字：内容」一行一条，前面带现在的时间。
   * 事件那一轮还把事件接在后面，它先看到群里刚发生的事，不照着过时的事件做。
   */
  private inputText(assistantId: string, group: Group, input: TurnInput, event?: EventText): string {
    const lines = input.items.map((item) => this.lineOf(item, group.id)).filter(Boolean);
    const body = [lines.join("\n"), ...(event === undefined ? [] : [`[hob-event] ${typeof event === "function" ? event() : event}`])].filter(Boolean).join("\n\n");
    return `${nowBlock(this.runtime, assistantId, group.id)}\n\n${body}`;
  }

  private inputFiles(input: TurnInput): string[] {
    return [...new Set(input.items.flatMap((item) => item.kind === "user" ? item.files ?? [] : sentFiles(item)))];
  }

  /** 给到哪一条了：下一轮从这里往后算（只调了工具没说话的回合也记得住）。 */
  private markSeen(gid: string, assistantId: string, item: GroupItem | undefined): void {
    if (!item) return;
    const seen = this.store.groupState(gid).seen ?? {};
    this.store.saveGroupState(gid, { seen: { ...seen, [assistantId]: item.id } });
  }

  /** 时间线里的一条写成一行事实，卡片也写成一句。 */
  private lineOf(item: GroupItem, gid: string): string {
    const who = this.speakerName(item.speaker);
    switch (item.kind) {
      case "user": {
        const parts = [item.text];
        if (item.quote) parts.push(`（引用：「${item.quote.text}」）`);
        if (item.files?.length) parts.push(`（附件：${item.files.join("、")}）`);
        return `${who}：${parts.filter(Boolean).join("")}`;
      }
      case "assistant":
      case "note":
        return `${who}：${item.text}`;
      case "job": {
        const job = this.store.job(item.jobId);
        return `${who}：创建了任务「${job?.title ?? item.jobId}」`;
      }
      case "question": {
        const approval = this.store.approval(item.approvalId);
        return `${who}：询问了用户${approval ? `「${approval.title}」` : "一个问题"}`;
      }
      case "file":
        return `${who}：发送了文件「${item.name}」（${item.path}）`;
      case "image":
        if (item.status === "pending") return `${who}：正在生成图片`;
        if (item.status === "failed") return `${who}：生成图片失败${item.error ? `（${item.error}）` : ""}`;
        return `${who}：生成了一张图片${item.path ? `（${item.path}）` : ""}`;
      case "draft":
        return `${who}：提议创建一个助手`;
      case "delegation":
        return `${who}：转交了一件事`;
      case "topic": {
        const topic = this.store.group(item.topicId);
        return `${who}：创建了话题「${topic?.name ?? item.topicId}」`;
      }
      case "card": {
        const card = this.store.card(item.cardId);
        return `${who}：${card ? cardHistoryLine(card.card) : "显示了一张卡片"}`;
      }
      default:
        return "";
    }
  }

  // ---------- 时间线 ----------

  items(gid: string, options: { before?: string; limit?: number } = {}): GroupItemsPage {
    this.group(gid);
    const all = this.timeline(gid);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const found = options.before ? all.findIndex((item) => item.id === options.before) : all.length;
    const end = found === -1 ? all.length : found;
    const start = Math.max(0, end - limit);
    const page = all.slice(start, end);
    const jobIds = new Set(page.flatMap((item) => (item.kind === "job" ? [item.jobId] : [])));
    const approvalIds = new Set(page.flatMap((item) => (item.kind === "question" ? [item.approvalId] : [])));
    const cardIds = new Set(page.flatMap((item) => (item.kind === "card" ? [item.cardId] : [])));
    return {
      items: page,
      approvals: this.store.approvals().filter((approval) => approvalIds.has(approval.id)),
      jobs: [...jobIds].flatMap((id) => {
        const job = this.store.job(id);
        return job ? [job] : [];
      }),
      cards: this.store.cards().filter((card) => cardIds.has(card.id)),
      hasMore: start > 0,
    };
  }

  /** 成员的一条回复开始输出：确认有可见正文后才建条目。 */
  delta(gid: string, assistantId: string, delta: string): void {
    const turn = this.turns.get(`${gid}@${assistantId}`);
    if (!turn) return;
    // 事件那一轮的文字等这一轮结束再写（settle 里先攒着），这里不先出条目
    if (turn.event) return;
    if (!turn.itemId) {
      const buffered = (turn.streamBuf ?? "") + delta;
      const start = buffered.trimStart();
      let body = start;
      while (body.startsWith(NO_REPLY)) body = body.slice(NO_REPLY.length).trimStart();
      if (NO_REPLY.startsWith(body)) {
        turn.streamBuf = buffered;
        return;
      }
      delta = body === start ? buffered : body;
      turn.streamBuf = undefined;
      const item = this.append(gid, { kind: "assistant", speaker: assistantId, text: "", streaming: true });
      turn.itemId = item.id;
      this.bus.emit({ type: "group-item", groupId: gid, item });
    }
    this.bus.emit({ type: "group-delta", groupId: gid, itemId: turn.itemId, text: delta });
  }

  /** 说完一条：完整正文按同一个 id 再写一行（后者覆盖前面的）；下一段文字是另一条。 */
  settle(gid: string, assistantId: string, text: string): void {
    const turn = this.turns.get(`${gid}@${assistantId}`);
    if (!turn) return;
    // 事件那一轮：先攒在手里，runTurn 结束时才知道这一轮该不该说
    if (turn.event) {
      if (text.trim()) (turn.held ??= []).push(text);
      return;
    }
    const id = turn.itemId;
    turn.itemId = undefined;
    turn.streamBuf = undefined;
    // 最终正文首尾去掉标记，什么都不剩就当作这一段没说
    const visible = stripNoReply(text);
    if (saysNoReply(text)) turn.silent = true;
    if (!visible) {
      // 只流出了空白（工具调用前的换行）：把那条流式条目收掉，重启时才不会当成中断
      if (id) this.bus.emit({ type: "group-item", groupId: gid, item: this.append(gid, { kind: "assistant", speaker: assistantId, text: "" }, id) });
      return;
    }
    turn.text = turn.text ? `${turn.text}\n${visible}` : visible;
    const item = this.append(gid, { kind: "assistant", speaker: assistantId, text: visible }, id ?? this.nextId(gid));
    turn.lastId = item.id;
    this.bus.emit({ type: "group-item", groupId: gid, item });
    this.publish(gid);
  }

  /**
   * 事件那一轮收尾：以 NO_REPLY 收尾就一段都不写，也不按里面的 @ 叫人；
   * 不然把攒着的各段照原来那样按顺序写进时间线。
   */
  private settleEventTurn(gid: string, assistantId: string, turn: RunningTurn): void {
    const held = turn.held ?? [];
    turn.held = [];
    if (!held.length) return;
    if (saysNoReply(held.at(-1)!)) { turn.silent = true; return; }
    for (const one of held) {
      const text = stripNoReply(one);
      if (!text) continue;
      turn.text = turn.text ? `${turn.text}\n${text}` : text;
      const item = this.append(gid, { kind: "assistant", speaker: assistantId, text });
      turn.lastId = item.id;
      this.bus.emit({ type: "group-item", groupId: gid, item });
    }
    this.publish(gid);
  }

  /** 卡片、文件、图片从会话落进时间线：发言人是这个成员，id 照 g-N 分配。 */
  appendItem(gid: string, speaker: string, item: NewItem & { forwardedFrom?: GroupItem["forwardedFrom"] }): GroupItem {
    const full = this.append(gid, { ...item, speaker });
    this.bus.emit({ type: "group-item", groupId: gid, item: full });
    return full;
  }

  /** 条目更新（图片画完、失败）：同一个 id 再写一行，读的时候后者覆盖前者。 */
  updateImageItem(gid: string, id: string, update: { status: "done" | "failed"; path?: string; error?: string }): GroupItem | undefined {
    const item = this.store.groupItems(gid).find((entry) => entry.id === id && entry.kind === "image");
    if (item?.kind !== "image") return undefined;
    const full: GroupItem = { ...item, ...update, id, at: item.at };
    this.store.appendGroupItem(gid, full);
    this.bus.emit({ type: "group-item", groupId: gid, item: full });
    return full;
  }

  /** 一行系统提示（停下、重启、无响应、记忆已更新）。 */
  note(gid: string, speaker: string, text: string, icon: NoteIcon = "info", detail?: string, targetGroupId?: string): GroupItem {
    const visibleText = text === RELAY_NOTE ? t("群内转交次数过多，已在此暂停。") : text === RESTART_NOTE ? t("服务已重启，本轮已中断。") : text;
    return this.appendItem(gid, speaker, { kind: "note", icon, text: visibleText, ...(detail ? { detail } : {}), ...(targetGroupId ? { targetGroupId } : {}) });
  }

  /** 给这个群（或话题）时间线上最新的一条用户消息（或指定的那条）点表情回应；再点会换掉。 */
  react(gid: string, assistantId: string, emoji: string, itemId?: string): { ok: true; itemId: string } | { ok: false; error: string } {
    const group = this.group(gid);
    if (!group.members.includes(assistantId)) return { ok: false, error: "你不是这个群的成员。" };
    const target = this.timeline(gid).findLast((item) => item.kind === "user" && (!itemId || item.id === itemId));
    if (!target || target.kind !== "user") return { ok: false, error: "这个群里还没有用户的消息，无法添加表情回应。" };
    const all = this.store.groupState(gid).reactions ?? {};
    const forItem = { ...(all[target.id] ?? {}), [assistantId]: emoji };
    this.store.saveGroupState(gid, { reactions: { ...all, [target.id]: forItem } });
    const reactions = reactionsList(forItem);
    this.bus.emit({ type: "group-item", groupId: gid, item: { ...target, ...(reactions ? { reactions } : {}) } });
    return { ok: true, itemId: target.id };
  }

  /** 这一个群的时间线（去掉没说完的空回复，用户条目补上表情回应）。 */
  timeline(gid: string): GroupItem[] {
    const storedReactions = this.store.groupState(gid).reactions;
    return this.store.groupItems(gid)
      .filter((item) => item.kind !== "assistant" || item.text.trim().length > 0)
      .map((item) => {
        if (item.kind !== "user") return item;
        const reactions = reactionsList(storedReactions?.[item.id]);
        return reactions ? { ...item, reactions } : item;
      });
  }

  private append(gid: string, item: NewGroupItem, id = this.nextId(gid)): GroupItem {
    const full = { ...item, id, at: new Date().toISOString() } as GroupItem;
    this.store.appendGroupItem(gid, full);
    return full;
  }

  /** 条目 id 按群递增：g-1、g-2…；几份成员会话合在一条时间线上，不能用单聊的 a-N。 */
  private nextId(gid: string): string {
    const next = (this.counters.get(gid) ?? this.lastItemNumber(gid, this.store.groupItems(gid))) + 1;
    this.counters.set(gid, next);
    return `g-${next}`;
  }

  private lastItemNumber(gid: string, items: GroupItem[]): number {
    return items.reduce((max, item) => {
      const match = /^g-(\d+)$/.exec(item.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, this.counters.get(gid) ?? 0);
  }

  private speakerName(speaker: string): string {
    if (speaker === "user") return "用户";
    if (speaker === SYSTEM) return "系统";
    return this.nameOf(speaker);
  }

  private nameOf(assistantId: string): string {
    return this.store.assistant(assistantId)?.name ?? assistantId;
  }

  private group(gid: string): Group {
    const group = this.store.group(gid);
    if (!group) throw new Error(`群不存在：${gid}`);
    return group;
  }

  /** 重启：被中断的回合和单聊一样不续，但时间线里留一条说明，不留永远在流式的条目。 */
  private repairInterrupted(): void {
    for (const group of this.store.groups()) {
      for (const item of this.store.groupItems(group.id)) {
        if (item.kind !== "assistant" || !item.streaming) continue;
        this.store.appendGroupItem(group.id, { ...item, streaming: false });
        this.note(group.id, SYSTEM, RESTART_NOTE, "info");
      }
    }
  }
}
