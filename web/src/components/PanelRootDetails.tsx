import { t } from "../../../shared/i18n.ts";
import { byStarted } from "../home.ts";
import { panelAssistant } from "../panel-stack.ts";
import { DelayedText, Empty } from "./Empty.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fileIcon } from "../file-icons.ts";
import { Icon } from "../icons.tsx";
import { jobStatusIcon } from "./status-meta.tsx";
import { DetailRow } from "./DetailRow.tsx";
import { groupSidebarFiles, routineSummary, sidebarInfoValues } from "../sidebar-data.ts";
import { loadAssistantSkills, loadGroupArtifacts, loadGroupProfile, loadPlugins, loadSidebarCollections, loadSidebarFiles, loadSidebarJobs, openArtifact, openFilePreview, openJob, openPlugins, openSidebarPage, setGroupPanelRootTab, useApp } from "../store.ts";
import { fmtBytes, fmtDuration, fmtElapsed, fmtWhen } from "../util.ts";

function LoadingRow() { return <div className="sidebar-loading" role="status"><DelayedText text={t("正在读取…")} /></div>; }

export function PanelRootDetails({ groupId, artifactGroupId, part, desktopRow, replyModeRow }: { groupId?: string; artifactGroupId?: string; part?: "info" | "tabs"; desktopRow?: ReactNode; replyModeRow?: ReactNode } = {}) {
  const s = useApp();
  const aid = groupId ?? panelAssistant(s.panelStack, s.sel);
  const groupProfile = groupId ? s.groupProfiles[groupId] : undefined;
  const profile = s.profiles[aid];
  const a = profile?.assistant ?? s.assistants.find((item) => item.id === aid);
  const routines = s.routines.filter((item) => groupId ? item.groupId === groupId || s.groups.some((g) => g.id === item.groupId && g.parentId === groupId) : item.assistantId === aid && !item.groupId);
  const skills = s.assistantSkills[aid];
  const artifactTargetId = artifactGroupId ?? groupId;
  // 页签的键不跟语言走，显示的标签渲染时再翻
  const [tab, setTab] = useState<"jobs" | "artifacts" | "files">(() =>
    groupId && artifactTargetId && s.panelRootTab?.groupId === artifactTargetId ? s.panelRootTab.tab : "jobs",
  );
  const tabsRef = useRef<HTMLDivElement>(null);
  const [collectionsError, setCollectionsError] = useState("");
  const [collectionsLoading, setCollectionsLoading] = useState(!s.knowledge.collectionsLoaded);
  const [enabledPlugins, setEnabledPlugins] = useState<number | null>(null);
  const jobsPage = s.sidebarJobs?.[aid];
  const filesPage = s.sidebarFiles?.[aid];
  const files = filesPage?.items ?? [];
  const jobs = Object.values({ ...Object.fromEntries((jobsPage?.items ?? []).map((job) => [job.id, job])), ...s.jobs }).filter((job) => groupId ? job.groupId === groupId || s.groups.some((g) => g.id === job.groupId && g.parentId === groupId) : job.assistantId === aid && !job.groupId).sort(byStarted);
  const seenJobs = useRef<{ aid: string; ids: Set<string> } | null>(null);
  const jobsReady = useRef(false);
  if (!seenJobs.current || seenJobs.current.aid !== aid) { seenJobs.current = { aid, ids: new Set() }; jobsReady.current = false; }
  const freshJobs = jobsPage?.loaded ? new Set(jobs.filter((job) => !seenJobs.current!.ids.has(job.id)).map((job) => job.id)) : new Set<string>();
  useEffect(() => { if (!jobsPage?.loaded) { jobsReady.current = false; return; } jobs.forEach((job) => seenJobs.current?.ids.add(job.id)); jobsReady.current = true; });
  useEffect(() => {
    const requested = groupId && artifactTargetId && s.panelRootTab?.groupId === artifactTargetId ? s.panelRootTab.tab : "jobs";
    setTab(requested);
    if (part !== "tabs") { void loadAssistantSkills(aid); if (groupId) void loadGroupProfile(groupId); }
    if (part !== "info") void loadSidebarJobs(aid);
  }, [aid, groupId, artifactTargetId, part]);
  useEffect(() => {
    if (!groupId || !artifactTargetId || !s.panelRootTab || s.panelRootTab.groupId !== artifactTargetId) return;
    setTab(s.panelRootTab.tab);
    if (s.panelRootTab.reveal) {
      tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [groupId, artifactTargetId, s.panelRootTab]);
  useEffect(() => { if (!groupId && !s.knowledge.collectionsLoaded) { setCollectionsLoading(true); setCollectionsError(""); void loadSidebarCollections().catch((e: unknown) => setCollectionsError(e instanceof Error ? e.message : String(e))).finally(() => setCollectionsLoading(false)); } }, [groupId, s.knowledge.collectionsLoaded]);
  useEffect(() => {
    if (groupId || part === "tabs") return;
    let active = true;
    void loadPlugins().then((view) => {
      if (active) setEnabledPlugins(view.plugins.filter((entry) => entry.plugin.enabled).length);
    }).catch(() => {});
    return () => { active = false; };
  }, [groupId, part]);
  useEffect(() => { if (tab === "files") void loadSidebarFiles(aid); }, [aid, tab]);
  useEffect(() => { if (tab === "artifacts" && artifactTargetId) void loadGroupArtifacts(artifactTargetId); }, [artifactTargetId, tab]);
  const page = tab === "jobs" ? jobsPage : tab === "files" ? filesPage : undefined;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !page?.hasMore || page.loading || page.error) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void (tab === "jobs" ? loadSidebarJobs(aid, true) : loadSidebarFiles(aid, true)); }, { root: element.closest(".panel") });
    observer.observe(element);
    return () => observer.disconnect();
  }, [aid, tab, page?.hasMore, page?.loading, page?.error, page?.cursor]);
  const collections = (a?.knowledge ?? []).map((id) => s.knowledge.collections.find((c) => c.id === id)?.name).filter((name): name is string => !!name);
  const values = sidebarInfoValues(skills?.skills.length ?? 0, collections, groupId ? groupProfile?.value?.rules.length ?? 0 : profile?.rules.length ?? 0);
  const groups = groupSidebarFiles(files);
  const targetGroup = artifactTargetId ? s.groups.find((item) => item.id === artifactTargetId) : undefined;
  const artifactPage = artifactTargetId ? s.groupArtifacts?.[artifactTargetId] : undefined;
  const artifactCount = artifactPage?.loaded ? artifactPage.items.length : (targetGroup?.artifactCount ?? 0);
  const tabs = [
    { key: "jobs", label: t("任务") },
    ...(groupId ? [{ key: "artifacts", label: t("文档") } as const] : []),
    { key: "files", label: t("文件") },
  ] as const;
  return <>
    {part !== "tabs" ? <div className="group-card sidebar-info">
      <button onClick={() => openSidebarPage("routines", groupId)}><Icon name="clock" size={15} /><span>{t("定时任务")}</span><small>{routineSummary(routines, s.settings.settings.general.timezone)}</small><b>›</b></button>
      {desktopRow}
      <button onClick={() => openSidebarPage("skills", groupId)}><Icon name="book" size={15} /><span>{t("技能")}</span><small>{skills?.error ? t("加载失败") : !skills?.loaded ? <DelayedText key={aid} text={t("正在加载…")} /> : values.skills}</small><b>›</b></button>
      {!groupId ? <button onClick={() => openPlugins()}><Icon name="plugin" size={15} /><span>{t("插件")}</span><small>{enabledPlugins === null ? "" : enabledPlugins > 0 ? t("{n} 个", { n: enabledPlugins }) : t("没有")}</small><b>›</b></button> : null}
      {!groupId ? <button onClick={() => openSidebarPage("knowledge")}><Icon name="archive" size={15} /><span>{t("知识库")}</span><small>{collectionsError ? t("加载失败") : collectionsLoading ? <DelayedText text={t("正在加载…")} /> : values.knowledge}</small><b>›</b></button> : null}
      <button onClick={() => openSidebarPage("rules", groupId)}><Icon name="rule" size={15} /><span>{t("执行前确认")}</span><small>{groupId && groupProfile?.error ? t("加载失败") : groupId && !groupProfile?.value ? <DelayedText text={t("正在加载…")} /> : values.rules}</small><b>›</b></button>
      {replyModeRow}
    </div> : null}
    {part !== "info" ? <>
    <div className="sidebar-tabs" ref={tabsRef}><div className="seg" style={{ "--seg-count": tabs.length, "--seg-index": Math.max(0, tabs.findIndex(({ key }) => key === tab)) } as React.CSSProperties}>{tabs.map(({ key, label }) => <button key={key} className={tab === key ? "on" : ""} onClick={() => { setTab(key); if (artifactTargetId) setGroupPanelRootTab(artifactTargetId, key); }}>{label}{key === "artifacts" && artifactCount > 0 ? <span className="seg-count">{artifactCount}</span> : null}</button>)}</div></div>
    {tab === "artifacts" && artifactTargetId ? <ArtifactList key={artifactTargetId} groupId={artifactTargetId} /> : <div key={tab} className="sidebar-tab-content"><div className="group-card sidebar-list">
      {tab === "jobs" ? jobs.map((job) => <div className={`srow${jobsReady.current && freshJobs.has(job.id) ? " enter" : ""}`} key={job.id}><div className="srowclip"><DetailRow leading={jobStatusIcon(job.status, 16)} title={<>{job.routineId ? "⏱ " : ""}{job.title}</>} detail={`${groupId ? `${s.assistants.find((item) => item.id === job.assistantId)?.name ?? job.assistantName ?? job.assistantId} · ` : ""}${fmtWhen(job.startedAt ?? job.createdAt)}${job.status === "running" || job.status === "waiting" ? ` · ${t("已进行 {time}", { time: fmtElapsed(job.startedAt ?? job.createdAt) })}` : job.durationMs !== undefined ? ` · ${t("用时 {duration}", { duration: fmtDuration(job.durationMs) })}` : ""}`} onClick={() => openJob(job.id)} /></div></div>) : ([ [t("本周"), groups.week], [t("更早"), groups.older] ] as const).map(([label, items]) => items.length ? <div key={label}><div className="sidebar-group-label">{label}</div>{items.map((entry) => <DetailRow key={entry.id} leading={<Icon name={fileIcon(entry.name)} size={18} />} title={entry.name} detail={`${fmtBytes(entry.size)} · ${fmtWhen(entry.updatedAt)}`} onClick={() => openFilePreview(entry.path, entry.name)} />)}</div> : null)}
      {page?.loaded && !(tab === "jobs" ? jobs.length : files.length) && !page.error ? <Empty>{tab === "jobs" ? t("分派的任务会显示在这里") : t("还没有产出文件")}</Empty> : null}
      {page?.error ? <div className="badline">{t("加载失败：{error}", { error: page.error })} <button onClick={() => void (tab === "jobs" ? loadSidebarJobs(aid, page.failedMore) : loadSidebarFiles(aid, page.failedMore))}>{t("重试")}</button></div> : null}
      {(!page?.loaded && !page?.error) || page?.loadingMore ? <LoadingRow /> : null}
      {page?.hasMore && !page.error ? <div ref={sentinel} /> : null}
    </div></div>}</> : null}
  </>;
}

function ArtifactList({ groupId }: { groupId: string }) {
  const s = useApp();
  const page = s.groupArtifacts[groupId];
  return <div className="sidebar-tab-content"><div className="group-card sidebar-list">
    <DetailRow leading={<Icon name="plus" size={16} />} title={t("新建文档")} onClick={() => openArtifact(groupId)} />
    {page?.items.map((entry) => {
      const author = entry.updatedBy === "user" ? t("用户") : s.assistants.find((item) => item.id === entry.updatedBy)?.name ?? (entry.updatedBy || t("未知作者"));
      return <DetailRow key={entry.name} leading={<Icon name="doc" size={18} />} title={entry.title === entry.name ? entry.name : `${entry.title} · ${entry.name}`}
        detail={`${author} · v${entry.version} · ${fmtWhen(entry.updatedAt)}`} onClick={() => openArtifact(groupId, entry.name)} />;
    })}
    {page?.error ? <div className="badline">{t("加载失败：{error}", { error: page.error })} <button onClick={() => void loadGroupArtifacts(groupId)}>{t("重试")}</button></div> : null}
    {page?.loaded && !page.items.length && !page.error ? <Empty>{t("还没有共享文档，成员或你可以随时新建")}</Empty> : null}
    {!page?.loaded && !page?.error ? <LoadingRow /> : null}
  </div></div>;
}
