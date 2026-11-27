import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { t } from "../../../shared/i18n.ts";
import type { LocalMemoryEntry, LocalMemoryView, MemoryProvider } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import {
  addLocalMemory,
  clearDoneLocalScratchpad,
  deleteLocalMemory,
  loadLocalMemory,
  updateLocalMemory,
} from "../store.ts";
import { Disclosure } from "./Disclosure.tsx";
import { Empty } from "./Empty.tsx";
import { Group } from "./SettingsParts.tsx";

type MemoryTab = "long_term" | "scratchpad" | "daily";

function sourceLabel(source?: string): string | null {
  if (!source) return null;
  return source === "user" ? t("用户") : t("助手");
}

export function MemoryInspector({ provider, loreUrl }: { provider: MemoryProvider; loreUrl: string | null }) {
  const [view, setView] = useState<LocalMemoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<MemoryTab>("long_term");
  const [query, setQuery] = useState("");
  const [draftLongTerm, setDraftLongTerm] = useState("");
  const [draftScratchpad, setDraftScratchpad] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [loreDisclosureOpen, setLoreDisclosureOpen] = useState(false);

  const refresh = async (date?: string) => {
    setLoading(true);
    setError(null);
    const result = await loadLocalMemory(date);
    setLoading(false);
    if (result.ok) setView(result.view);
    else setError(result.error);
  };

  useEffect(() => {
    void refresh();
  }, [provider]);

  const hasLocalEntries = Boolean(
    view && (view.longTerm.length > 0 || view.scratchpad.length > 0 || view.dailyDates.length > 0),
  );
  const doneCount = useMemo(
    () => (view ? view.scratchpad.filter((item) => item.done).length : 0),
    [view],
  );

  const needle = query.trim().toLowerCase();
  const filteredLongTerm = useMemo(() => {
    const list = view?.longTerm ?? [];
    if (!needle) return list;
    return list.filter((entry) => entry.text.toLowerCase().includes(needle));
  }, [view, needle]);

  const filteredScratchpad = useMemo(() => {
    const list = view?.scratchpad ?? [];
    if (!needle) return list;
    return list.filter((entry) => entry.text.toLowerCase().includes(needle));
  }, [view, needle]);

  const filteredDaily = useMemo(() => {
    const list = view?.daily ?? [];
    if (!needle) return list;
    return list.filter((entry) => entry.text.toLowerCase().includes(needle));
  }, [view, needle]);

  const runMutation = async (fn: () => Promise<{ ok: true; view: LocalMemoryView } | { ok: false; error: string }>) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setView(result.view);
    return true;
  };

  const handleAddLongTerm = async () => {
    const text = draftLongTerm.trim();
    if (!text) return;
    const ok = await runMutation(() => addLocalMemory({ target: "long_term", text }));
    if (ok) setDraftLongTerm("");
  };

  const handleSaveEdit = async (id: string) => {
    const text = editingText.trim();
    if (!text) return;
    const ok = await runMutation(() => updateLocalMemory(id, { target: "long_term", text }));
    if (ok) {
      setEditingId(null);
      setEditingText("");
    }
  };

  const handleDeleteLongTerm = async (id: string) => {
    const ok = await runMutation(() => deleteLocalMemory(id, "long_term"));
    if (ok) setConfirmDeleteId(null);
  };

  const handleAddScratchpad = async () => {
    const text = draftScratchpad.trim();
    if (!text) return;
    const ok = await runMutation(() => addLocalMemory({ target: "scratchpad", text }));
    if (ok) setDraftScratchpad("");
  };

  const handleToggleScratchpad = async (id: string, done: boolean) => {
    await runMutation(() => updateLocalMemory(id, { target: "scratchpad", done }));
  };

  const handleSaveScratchpadEdit = async (id: string) => {
    const text = editingText.trim();
    if (!text) return;
    const ok = await runMutation(() => updateLocalMemory(id, { target: "scratchpad", text }));
    if (ok) {
      setEditingId(null);
      setEditingText("");
    }
  };

  const handleDeleteScratchpad = async (id: string) => {
    const ok = await runMutation(() => deleteLocalMemory(id, "scratchpad"));
    if (ok) setConfirmDeleteId(null);
  };

  const handleClearDone = async () => {
    await runMutation(() => clearDoneLocalScratchpad());
  };

  const handleSelectDailyDate = async (date: string) => {
    setConfirmDeleteId(null);
    await refresh(date);
  };

  const handleDeleteDaily = async (id: string) => {
    const date = view?.dailyDate;
    if (!date) return;
    const ok = await runMutation(() => deleteLocalMemory(id, "daily", date));
    if (ok) setConfirmDeleteId(null);
  };

  const tabs: { key: MemoryTab; label: string; count: number }[] = [
    { key: "long_term", label: t("长期记忆"), count: needle ? filteredLongTerm.length : (view?.longTerm.length ?? 0) },
    { key: "scratchpad", label: t("备忘清单"), count: needle ? filteredScratchpad.length : (view?.scratchpad.length ?? 0) },
    { key: "daily", label: t("每日记录"), count: needle && tab === "daily" ? filteredDaily.length : (view?.dailyDates.length ?? 0) },
  ];

  const renderMemoryCard = (entry: LocalMemoryEntry, kind: "long_term" | "daily") => {
    const isEditing = kind === "long_term" && editingId === entry.id;
    const isConfirming = confirmDeleteId === entry.id;
    const who = sourceLabel(entry.source);
    const meta = [who, entry.updatedAt].filter(Boolean).join(" · ");

    return (
      <div className="group-card mem-card" key={entry.id}>
        {isEditing ? (
          <div className="mem-edit">
            <label className="field">
              <textarea
                rows={3}
                autoFocus
                value={editingText}
                disabled={busy}
                onChange={(event) => setEditingText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void handleSaveEdit(entry.id);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setEditingId(null);
                    setEditingText("");
                  }
                }}
              />
            </label>
            <div className="mem-actions">
              <button
                type="button"
                className="hob-btn"
                disabled={busy}
                onClick={() => {
                  setEditingId(null);
                  setEditingText("");
                }}
              >
                {t("取消")}
              </button>
              <button
                type="button"
                className="hob-btn hob-btn-primary"
                disabled={busy || !editingText.trim()}
                onClick={() => void handleSaveEdit(entry.id)}
              >
                {t("保存")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mem-text">{entry.text}</div>
            <div className="mem-foot">
              <span className="mem-meta">{meta}</span>
              {isConfirming ? (
                <div className="mem-confirm">
                  <button
                    type="button"
                    className="hob-btn hob-btn-danger"
                    disabled={busy}
                    onClick={() => void (kind === "long_term" ? handleDeleteLongTerm(entry.id) : handleDeleteDaily(entry.id))}
                  >
                    {t("确认删除")}
                  </button>
                  <button
                    type="button"
                    className="hob-btn"
                    disabled={busy}
                    onClick={() => setConfirmDeleteId(null)}
                  >
                    {t("取消")}
                  </button>
                </div>
              ) : (
                <div className="mem-actions">
                  {kind === "long_term" ? (
                    <button
                      type="button"
                      className="mem-action-btn"
                      disabled={busy}
                      onClick={() => {
                        setConfirmDeleteId(null);
                        setEditingId(entry.id);
                        setEditingText(entry.text);
                      }}
                    >
                      <Icon name="edit" size={13} />
                      {t("编辑")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="mem-action-btn danger"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(null);
                      setConfirmDeleteId(entry.id);
                    }}
                  >
                    <Icon name="trash" size={13} />
                    {t("删除")}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const inspectorBody = (
    <div className="mem-inspector">
      <div className="mem-head">
        <div className="mem-head-text">
          <div className="lbl">{t("我的记忆")}</div>
          <div className="note">{t("直接查看、补充或删改助手记住的偏好、备忘和每日记录。")}</div>
        </div>
        <button
          type="button"
          className="hob-icon-btn"
          title={t("刷新记忆")}
          aria-label={t("刷新记忆")}
          disabled={loading || busy}
          onClick={() => void refresh(tab === "daily" ? view?.dailyDate : undefined)}
        >
          <Icon name="retry" size={15} className={loading ? "spin" : undefined} />
        </button>
      </div>

      <div className="mem-toolbar">
        <div
          className="seg"
          role="tablist"
          aria-label={t("我的记忆")}
          style={{ "--seg-count": tabs.length, "--seg-index": Math.max(0, tabs.findIndex((item) => item.key === tab)) } as CSSProperties}
        >
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={tab === item.key ? "on" : undefined}
              onClick={() => {
                setTab(item.key);
                setConfirmDeleteId(null);
                setEditingId(null);
              }}
            >
              {item.label}
              {item.count > 0 ? <span className="seg-count">{item.count}</span> : null}
            </button>
          ))}
        </div>

        <div className="mem-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            placeholder={t("搜索记忆内容…")}
            aria-label={t("搜索记忆内容…")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="mem-search-clear"
              title={t("清空搜索")}
              aria-label={t("清空搜索")}
              onClick={() => setQuery("")}
            >
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="badline" role="alert">{error}</div> : null}

      {loading && !view ? (
        <Empty>{t("正在读取本地记忆…")}</Empty>
      ) : tab === "long_term" ? (
        <div className="mem-pane">
          <form
            className="formcard mem-add"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddLongTerm();
            }}
          >
            <label className="field">
              <textarea
                rows={2}
                value={draftLongTerm}
                disabled={busy}
                placeholder={t("例如：回复尽量精简，日期用 24 小时制…")}
                onChange={(event) => setDraftLongTerm(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void handleAddLongTerm();
                  }
                }}
              />
            </label>
            <div className="mem-add-foot">
              <span className="note">{t("助手每次对话都会参考长期记忆。")}</span>
              <button
                type="submit"
                className="hob-btn hob-btn-primary"
                disabled={busy || !draftLongTerm.trim()}
              >
                {t("添加")}
              </button>
            </div>
          </form>

          {filteredLongTerm.length > 0 ? (
            <div className="mem-list">
              {filteredLongTerm.map((entry) => renderMemoryCard(entry, "long_term"))}
            </div>
          ) : (
            <Empty>{needle ? t("没有找到匹配的长期记忆") : t("还没有长期记忆，你可以手动添加，或在对话中让助手记住。")}</Empty>
          )}
        </div>
      ) : tab === "scratchpad" ? (
        <div className="mem-pane">
          <form
            className="mem-add-inline"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddScratchpad();
            }}
          >
            <label className="field">
              <input
                value={draftScratchpad}
                disabled={busy}
                placeholder={t("添加一条待记住的事…")}
                onChange={(event) => setDraftScratchpad(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="hob-btn hob-btn-primary"
              disabled={busy || !draftScratchpad.trim()}
            >
              {t("添加")}
            </button>
            {doneCount > 0 ? (
              <button
                type="button"
                className="hob-btn"
                disabled={busy}
                onClick={() => void handleClearDone()}
              >
                {t("清理已完成")}
              </button>
            ) : null}
          </form>

          {filteredScratchpad.length > 0 ? (
            <div className="group-card mem-checklist">
              {filteredScratchpad.map((item) => {
                const isEditing = editingId === item.id;
                const isConfirming = confirmDeleteId === item.id;
                return (
                  <div className={`mem-check-row${item.done ? " done" : ""}`} key={item.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={item.done}
                      className={`mem-check-box${item.done ? " on" : ""}`}
                      disabled={busy || isEditing}
                      title={item.done ? t("标为未完成") : t("标为已完成")}
                      onClick={() => void handleToggleScratchpad(item.id, !item.done)}
                    >
                      {item.done ? <Icon name="check" size={12} w={2.4} /> : null}
                    </button>
                    {isEditing ? (
                      <div className="mem-edit" style={{ flex: 1 }}>
                        <label className="field">
                          <input
                            autoFocus
                            value={editingText}
                            disabled={busy}
                            onChange={(event) => setEditingText(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void handleSaveScratchpadEdit(item.id);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                setEditingId(null);
                                setEditingText("");
                              }
                            }}
                          />
                        </label>
                        <div className="mem-actions">
                          <button type="button" className="hob-btn" disabled={busy} onClick={() => { setEditingId(null); setEditingText(""); }}>
                            {t("取消")}
                          </button>
                          <button type="button" className="hob-btn hob-btn-primary" disabled={busy || !editingText.trim()} onClick={() => void handleSaveScratchpadEdit(item.id)}>
                            {t("保存")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mem-check-main">
                          <span className="mem-check-text">{item.text}</span>
                          {item.updatedAt ? <span className="mem-meta">{item.updatedAt}</span> : null}
                        </div>
                        {isConfirming ? (
                          <div className="mem-confirm">
                            <button type="button" className="hob-btn hob-btn-danger" disabled={busy} onClick={() => void handleDeleteScratchpad(item.id)}>
                              {t("确认删除")}
                            </button>
                            <button type="button" className="hob-btn" disabled={busy} onClick={() => setConfirmDeleteId(null)}>
                              {t("取消")}
                            </button>
                          </div>
                        ) : (
                          <div className="mem-actions">
                            <button
                              type="button"
                              className="hob-icon-btn mem-check-del"
                              title={t("编辑")}
                              aria-label={t("编辑")}
                              disabled={busy}
                              onClick={() => {
                                setConfirmDeleteId(null);
                                setEditingId(item.id);
                                setEditingText(item.text);
                              }}
                            >
                              <Icon name="edit" size={14} />
                            </button>
                            <button
                              type="button"
                              className="hob-icon-btn mem-check-del"
                              title={t("删除")}
                              aria-label={t("删除")}
                              disabled={busy}
                              onClick={() => {
                                setEditingId(null);
                                setConfirmDeleteId(item.id);
                              }}
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty>{needle ? t("没有找到匹配的备忘项") : t("备忘清单是空的，有临时事项可以随手记在这里。")}</Empty>
          )}
        </div>
      ) : (
        <div className="mem-pane">
          {view && view.dailyDates.length > 0 ? (
            <>
              <div className="mem-dates" role="tablist" aria-label={t("选择日期")}>
                {view.dailyDates.map((date) => (
                  <button
                    key={date}
                    type="button"
                    role="tab"
                    aria-selected={view.dailyDate === date}
                    className={`mem-date-pill${view.dailyDate === date ? " on" : ""}`}
                    disabled={loading || busy}
                    onClick={() => void handleSelectDailyDate(date)}
                  >
                    {date}
                  </button>
                ))}
              </div>
              {needle && view.dailyDates.length > 1 ? (
                <div className="note">{t("搜索仅筛选当前所选日期（{date}）的记录。", { date: view.dailyDate ?? "" })}</div>
              ) : null}
              {filteredDaily.length > 0 ? (
                <div className="mem-list">
                  {filteredDaily.map((entry) => renderMemoryCard(entry, "daily"))}
                </div>
              ) : (
                <Empty>{needle ? t("这一天没有匹配的记录") : t("这一天没有记录")}</Empty>
              )}
            </>
          ) : (
            <Empty>{t("还没有每日记录。助手按天记下的流水会出现在这里。")}</Empty>
          )}
        </div>
      )}
    </div>
  );

  const safeLoreUrl = loreUrl && /^https?:\/\//i.test(loreUrl.trim()) ? loreUrl.trim() : null;

  if (provider === "lore") {
    return (
      <Group>
        <div className="group-card mem-lore-card">
          <div className="mem-lore-body">
            <strong>{t("记忆由 Lore 托管")}</strong>
            <div className="note">{t("当前长期记忆保存在 Lore 服务中，你可以在 Lore 控制台浏览和整理全部节点。")}</div>
          </div>
          {safeLoreUrl ? (
            <a className="hob-btn" href={safeLoreUrl} target="_blank" rel="noreferrer">
              {t("在 Lore 中查看")}
              <Icon name="out" size={13} />
            </a>
          ) : null}
        </div>
        {hasLocalEntries ? (
          <Disclosure
            className="mem-local-disclosure"
            label={t("查看本机已有的本地记忆")}
            count={(view?.longTerm.length ?? 0) + (view?.scratchpad.length ?? 0)}
            open={loreDisclosureOpen}
            onToggle={() => setLoreDisclosureOpen((value) => !value)}
          >
            {inspectorBody}
          </Disclosure>
        ) : null}
      </Group>
    );
  }

  if (provider === "off") {
    if (!hasLocalEntries) return null;
    return (
      <Group>
        <div className="note">{t("记忆功能当前已关闭，以下为此前保存在本机的记录，仍可查看或清理。")}</div>
        {inspectorBody}
      </Group>
    );
  }

  return <Group>{inspectorBody}</Group>;
}
