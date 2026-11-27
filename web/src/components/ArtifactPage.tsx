import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { MAX_ARTIFACT_BYTES } from "../../../shared/group-artifact.ts";
import type { GroupArtifact } from "../../../shared/types.ts";
import { ApiError } from "../api.ts";
import { copyText } from "../clipboard.ts";
import { downloadMarkdownFile } from "../download.ts";
import { Icon } from "../icons.tsx";
import { backPanel, deleteGroupArtifact, getGroupArtifact, saveGroupArtifact, setNotice, useApp } from "../store.ts";
import { fmtWhen } from "../util.ts";
import { DelayedText } from "./Empty.tsx";
import { Markdown } from "./Markdown.tsx";

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function formatSizeKb(bytes: number): string {
  const kb = bytes / 1024;
  return kb >= 10 || bytes === 0 ? `${Math.round(kb)}` : kb.toFixed(1);
}

export function ArtifactPage({ groupId, name }: { groupId: string; name?: string }) {
  const s = useApp();
  const rev = s.groupArtifacts[groupId]?.rev ?? 0;
  const [artifact, setArtifact] = useState<GroupArtifact>();
  const [editing, setEditing] = useState(!name);
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [filename, setFilename] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const copyTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    if (editing || !name) return;
    let active = true;
    setLoadError(undefined);
    void getGroupArtifact(groupId, name).then((value) => {
      if (active) setArtifact(value);
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 404) setArtifact(undefined);
      setLoadError(t("加载失败：{error}", { error: messageOf(error) }));
    });
    return () => { active = false; };
  }, [groupId, name, rev, editing, retry]);

  const byteLength = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const overLimit = byteLength > MAX_ARTIFACT_BYTES;
  const dirty = editing && (name
    ? title !== (artifact?.title ?? "") || content !== (artifact?.content ?? "")
    : Boolean(filename.trim() || title.trim() || content.trim()));

  function edit(current: GroupArtifact) {
    setTitle(current.title);
    setContent(current.content);
    setPreview(false);
    setConfirmDelete(false);
    setConfirmDiscard(false);
    setConflict(false);
    setActionError(undefined);
    setEditing(true);
  }

  function exitEdit() {
    setConfirmDiscard(false);
    setConflict(false);
    setPreview(false);
    setActionError(undefined);
    if (!name) backPanel();
    else setEditing(false);
  }

  function requestCancel() {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else exitEdit();
  }

  async function copy(current: GroupArtifact) {
    if (!(await copyText(current.content))) {
      setNotice(t("复制失败：浏览器不允许写入剪贴板"));
      return;
    }
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  function download(current: GroupArtifact) {
    downloadMarkdownFile(current.name, current.content);
  }

  async function save() {
    if (busy || overLimit || !(name ?? filename.trim())) return;
    setBusy(true);
    setActionError(undefined);
    setConflict(false);
    setConfirmDiscard(false);
    try {
      const saved = await saveGroupArtifact(groupId, name ?? filename, {
        title,
        content,
        ...(name && artifact ? { expectedVersion: artifact.version } : {}),
      });
      // 新建时 store 把表单页换成正式的文档页。
      if (name) {
        setArtifact(saved);
        setPreview(false);
        setEditing(false);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      setActionError(t("保存失败：{error}", { error: messageOf(error) }));
    } finally { setBusy(false); }
  }

  async function reloadLatest() {
    if (!name || busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const latest = await getGroupArtifact(groupId, name);
      setArtifact(latest);
      setTitle(latest.title);
      setContent(latest.content);
      setConflict(false);
      setConfirmDiscard(false);
    } catch (error) {
      setActionError(t("加载失败：{error}", { error: messageOf(error) }));
    } finally { setBusy(false); }
  }

  const stateRef = useRef({ busy, dirty, save, requestCancel });
  stateRef.current = { busy, dirty, save, requestCancel };
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === "s" || event.key === "Enter")) {
        event.preventDefault();
        event.stopPropagation();
        void stateRef.current.save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        stateRef.current.requestCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing]);

  async function remove() {
    if (!name || busy) return;
    setBusy(true);
    setActionError(undefined);
    try { await deleteGroupArtifact(groupId, name); }
    catch (error) { setActionError(t("删除失败：{error}", { error: messageOf(error) })); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <form className="artifact-page" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="group-card artifact-editor">
          {!name ? (
            <label className="artifact-field">
              <span className="artifact-label">{t("文件名称")}</span>
              <span className="field">
                <input
                  autoFocus
                  required
                  maxLength={80}
                  value={filename}
                  placeholder={t("例如：方案.md")}
                  disabled={busy}
                  onChange={(event) => setFilename(event.target.value)}
                />
              </span>
            </label>
          ) : null}
          <label className="artifact-field">
            <span className="artifact-label">{t("文档标题")}</span>
            <span className="field">
              <input
                autoFocus={Boolean(name)}
                value={title}
                placeholder={t("例如：技术方案（可选）")}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
              />
            </span>
          </label>
          <div className="artifact-field">
            <span className="artifact-label-row">
              <span className="artifact-label">{t("Markdown 正文")}</span>
              <span className="artifact-editor-meta">
                <span className="artifact-mode-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={!preview} className={!preview ? "on" : undefined} onClick={() => setPreview(false)}>{t("编写")}</button>
                  <button type="button" role="tab" aria-selected={preview} className={preview ? "on" : undefined} onClick={() => setPreview(true)}>{t("预览")}</button>
                </span>
                <span className={`artifact-size${overLimit ? " over" : ""}`}>
                  {formatSizeKb(byteLength)} KB / 512 KB
                </span>
              </span>
            </span>
            {preview ? (
              <div className="artifact-preview">
                {content.trim() ? <Markdown className="fp-md markdown-body" text={content} /> : <div className="artifact-empty">{t("文档内容为空")}</div>}
              </div>
            ) : (
              <span className="field">
                <textarea
                  className="artifact-textarea"
                  rows={14}
                  value={content}
                  placeholder={t("支持 Markdown 语法…")}
                  disabled={busy}
                  onChange={(event) => setContent(event.target.value)}
                />
              </span>
            )}
          </div>
          {actionError ? (
            <div className="badline" role="alert">
              <span>{actionError}</span>
              {conflict && name ? <button type="button" disabled={busy} onClick={() => void reloadLatest()}>{t("重新加载最新内容")}</button> : null}
            </div>
          ) : null}
          {confirmDiscard ? (
            <div className="artifact-confirm" role="alert">
              <div>{t("有未保存的修改，确定放弃吗？")}</div>
              <div className="artifact-actions">
                <button type="button" className="hob-btn hob-btn-danger" disabled={busy} onClick={exitEdit}>
                  {t("放弃修改")}
                </button>
                <button type="button" className="hob-btn" disabled={busy} onClick={() => setConfirmDiscard(false)}>
                  {t("继续编辑")}
                </button>
              </div>
            </div>
          ) : null}
          <div className="artifact-footer">
            <button
              className="hob-btn"
              type="button"
              disabled={busy}
              onClick={requestCancel}
            >
              {t("取消")}
            </button>
            <button
              className="hob-btn hob-btn-primary"
              type="submit"
              disabled={busy || overLimit || (!name && !filename.trim())}
            >
              {busy ? t("正在保存…") : t("保存")}
            </button>
          </div>
        </div>
      </form>
    );
  }

  if (!artifact && !loadError) return <div role="status" className="sidebar-loading"><DelayedText text={t("正在读取…")} /></div>;
  const updatedBy = artifact?.updatedBy;
  const author = updatedBy === "user" ? t("用户") : s.assistants.find((item) => item.id === updatedBy)?.name ?? (updatedBy || t("未知作者"));
  return (
    <div className="artifact-page">
      {loadError ? <div className="badline" role="alert">{loadError} <button onClick={() => setRetry((value) => value + 1)}>{t("重试")}</button></div> : null}
      {artifact ? (
        <>
          <div className="group-card artifact-head">
            <div className="artifact-title-block">
              <h2>{artifact.title}</h2>
              <div className="artifact-meta">
                <code className="artifact-file">{artifact.name}</code>
                <span className="artifact-ver">v{artifact.version}</span>
                <span className="artifact-by">{author} · {fmtWhen(artifact.updatedAt)}</span>
              </div>
            </div>
            {confirmDelete ? (
              <div className="artifact-confirm">
                <div>{t("删除文档「{name}」？", { name: artifact.title })}</div>
                <div className="artifact-actions">
                  <button type="button" className="hob-btn hob-btn-danger" disabled={busy} onClick={() => void remove()}>
                    {busy ? t("正在删除…") : t("确认删除")}
                  </button>
                  <button type="button" className="hob-btn" disabled={busy} onClick={() => { setConfirmDelete(false); setActionError(undefined); }}>
                    {t("取消")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="artifact-actions">
                <button type="button" className="hob-btn" onClick={() => edit(artifact)}>
                  <Icon name="edit" size={14} />
                  {t("编辑")}
                </button>
                <button type="button" className="hob-btn" onClick={() => void copy(artifact)}>
                  <Icon name={copied ? "check" : "copy"} size={14} />
                  {copied ? t("已复制") : t("复制")}
                </button>
                <button type="button" className="hob-btn" onClick={() => download(artifact)}>
                  <Icon name="dl" size={14} />
                  {t("下载")}
                </button>
                <button type="button" className="hob-btn hob-btn-danger" onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" size={14} />
                  {t("删除")}
                </button>
              </div>
            )}
            {actionError ? <div className="badline" role="alert">{actionError}</div> : null}
          </div>
          <div className="group-card artifact-body">
            {artifact.content.trim() ? (
              <Markdown className="fp-md markdown-body" text={artifact.content} />
            ) : (
              <div className="artifact-empty">{t("文档内容为空，点「编辑」开始编写。")}</div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
