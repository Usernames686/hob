// 桌面首页：居中主助手、问候、输入框，有待处理事项时在下方展示微卡片。
import { useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { homeGroups } from "../home.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { openJob, openJobs, select, selectGroup, send, useApp } from "../store.ts";
import { sendName } from "./Chat.tsx";
import { JOB_STATUS, StatusTag } from "./status-meta.tsx";

function greeting(hour = new Date().getHours()): string {
  if (hour < 6) return t("夜深了");
  if (hour < 11) return t("早上好");
  if (hour < 13) return t("中午好");
  if (hour < 18) return t("下午好");
  return t("晚上好");
}

export function Home() {
  const s = useApp();
  const [text, setDraft] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const primary = s.assistants.find((a) => a.primary) ?? s.assistants[0];
  const g = homeGroups(s);
  const waiting = g.asks.length;
  const summary = [waiting ? t("{n} 件等你确认", { n: waiting }) : "", g.live.length ? t("{n} 件进行中", { n: g.live.length }) : ""].filter(Boolean).join(" · ") || t("现在没有要你处理的事");

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
  }, [text]);

  // 在首页说的话发给主助手，发完进它的对话
  const ask = () => {
    const body = text.trim();
    if (!body || !primary) return;
    void select(primary.id);
    setDraft("");
    void send(body);
  };

  const liveCards = g.live.slice(0, 3);
  const askCards = g.asks.slice(0, 2);
  const hiddenCount = (g.asks.length - askCards.length) + (g.live.length - liveCards.length);

  const hour = new Date().getHours();
  const heroState = waiting > 0 ? "curious" : g.live.length > 0 ? "thinking" : hour < 6 ? "sleeping" : "idle";

  return (
    <main className="home">
      <div className="home-in">
        {primary ? (
          <Avatar
            sprite={primary.sprite}
            prop={primary.prop}
            size={112}
            free
            live
            interactive
            follow
            petState={heroState}
            glow={waiting > 0 || g.live.length > 0}
          />
        ) : null}
        <h1>{greeting(hour)}</h1>
        <p className="home-sum">{summary}</p>
        <div className="comp home-ask">
          <div className="comp-main">
            <textarea
              ref={ta}
              className="ta"
              rows={1}
              value={text}
              placeholder={t("有事跟{assistant}说，它来安排", { assistant: sendName(primary?.name ?? "Hob") })}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  ask();
                }
              }}
            />
            <button className={`sendbtn${text.trim() ? " ready" : ""}`} title={t("发送")} aria-label={t("发送")} disabled={!text.trim()} onClick={ask}>
              <Icon name="send" size={17} />
            </button>
          </div>
        </div>
        {askCards.length || liveCards.length ? (
          <div className="home-cards">
            {askCards.map((ap) => {
              const owner = s.assistants.find((a) => a.id === ap.assistantId);
              return (
                <button
                  key={ap.id}
                  type="button"
                  className="home-card ask"
                  onClick={() => {
                    if (ap.jobId && s.jobs[ap.jobId]?.groupId) void selectGroup(s.jobs[ap.jobId]!.groupId!);
                    else void select(ap.assistantId);
                  }}
                >
                  {owner ? <Avatar sprite={owner.sprite} prop={owner.prop} size={30} mark="ask" /> : null}
                  <span className="home-card-body">
                    <strong>{ap.title}</strong>
                    <small>{owner?.name ?? ap.assistantId}</small>
                  </span>
                  <span className="home-card-tag ask">{t("等你确认")}</span>
                </button>
              );
            })}
            {liveCards.map((job) => {
              const owner = s.assistants.find((a) => a.id === job.assistantId);
              return (
                <button
                  key={job.id}
                  type="button"
                  className="home-card"
                  onClick={() => {
                    if (job.groupId) void selectGroup(job.groupId, true, false, true);
                    else if (owner) void select(owner.id);
                    openJob(job.id);
                  }}
                >
                  {owner ? <Avatar sprite={owner.sprite} prop={owner.prop} size={30} mark="busy" /> : null}
                  <span className="home-card-body">
                    <strong>{job.title}</strong>
                    <small>{owner?.name ?? job.assistantId}</small>
                  </span>
                  <StatusTag meta={JOB_STATUS[job.status]} card />
                </button>
              );
            })}
            {hiddenCount > 0 ? (
              <button type="button" className="home-card home-card-more" onClick={() => openJobs()}>
                <Icon name="tasks" size={16} />
                <span className="home-card-body">
                  <strong>{t("还有 {n} 项待处理", { n: hiddenCount })}</strong>
                  <small>{t("查看全部任务")}</small>
                </span>
                <Icon name="chev" size={14} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
