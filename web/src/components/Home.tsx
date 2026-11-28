// 桌面首页：居中主助手、问候、输入框，有待处理事项时在下方展示微卡片。
import { useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { homeGroups } from "../home.ts";
import { Icon } from "../icons.tsx";
import { deriveHomeMood, typingLook, useIdleSleep, useTypingPulse } from "../pet/pet-mood.ts";
import { Avatar } from "../sprites.tsx";
import { openJob, openJobs, select, selectGroup, send, useApp } from "../store.ts";
import { sendName } from "./Chat.tsx";

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
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
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

  const liveCards = g.live.slice(0, 4);
  const askCards = g.asks.slice(0, 2);
  const hiddenCount = (g.asks.length - askCards.length) + (g.live.length - liveCards.length);

  const hour = new Date().getHours();
  const isLateNight = hour < 6;
  const typing = useTypingPulse(text);
  const watchingInput = focused || typing;
  const idleAsleep = useIdleSleep(!watchingInput && waiting === 0 && g.live.length === 0, isLateNight ? 20000 : 60000, isLateNight);
  const heroState = deriveHomeMood({ waitingCount: waiting, liveCount: g.live.length, typing: watchingInput, idleAsleep });
  const taEl = ta.current;
  const taStyle = taEl && typeof getComputedStyle === "function" ? getComputedStyle(taEl) : null;
  const taFont = taStyle ? `${taStyle.fontWeight} ${taStyle.fontSize} ${taStyle.fontFamily}` : undefined;
  const taWidth = taEl ? Math.max(180, taEl.clientWidth - (parseFloat(taStyle?.paddingLeft || "0") + parseFloat(taStyle?.paddingRight || "0"))) : 480;
  const heroFocusLook = watchingInput ? typingLook(text, caret, taWidth, taFont) : undefined;

  return (
    <main className="home">
      <div className="home-in">
        {primary ? (
          <Avatar
            sprite={primary.sprite}
            size={112}
            free
            live
            interactive
            follow
            ambient
            petState={heroState}
            focusLook={heroFocusLook}
            glow={watchingInput || waiting > 0 || g.live.length > 0}
          />
        ) : null}
        <h1>{greeting(hour)}</h1>
        <p className="home-sum">
          <span className="home-sum-pill">
            <span className={`home-sum-dot${waiting > 0 ? " ask" : g.live.length > 0 ? " live" : ""}`} aria-hidden="true" />
            {summary}
          </span>
        </p>
        <div className="comp home-ask">
          <div className="comp-main">
            <textarea
              ref={ta}
              className="ta"
              rows={1}
              value={text}
              placeholder={t("有事跟{assistant}说，它来安排", { assistant: sendName(primary?.name ?? "Hob") })}
              onFocus={(e) => {
                setFocused(true);
                setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
              }}
              onBlur={() => setFocused(false)}
              onChange={(e) => {
                setDraft(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
              }}
              onCompositionUpdate={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
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
          <div className="home-deck">
            {askCards.length ? (
              <section className="home-sec">
                <div className="home-sec-head ask">
                  <span>{t("等你确认")}</span>
                  {!liveCards.length && hiddenCount > 0 ? (
                    <button type="button" className="home-sec-more" onClick={() => openJobs()}>
                      <span>{t("查看全部任务")}</span>
                      <Icon name="chev" size={12} />
                    </button>
                  ) : null}
                </div>
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
                        {owner ? <Avatar sprite={owner.sprite} size={30} mark="ask" /> : null}
                        <span className="home-card-body">
                          <strong>{ap.title}</strong>
                          <small>{owner?.name ?? ap.assistantId}</small>
                        </span>
                        <span className="home-card-tag ask">{t("等你确认")}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
            {liveCards.length ? (
              <section className="home-sec">
                <div className="home-sec-head">
                  <span>{t("进行中")}</span>
                  {hiddenCount > 0 ? (
                    <button type="button" className="home-sec-more" onClick={() => openJobs()}>
                      <span>{t("查看全部任务")}</span>
                      <Icon name="chev" size={12} />
                    </button>
                  ) : null}
                </div>
                <div className="home-live">
                  {liveCards.map((job) => {
                    const owner = s.assistants.find((a) => a.id === job.assistantId);
                    return (
                      <button
                        key={job.id}
                        type="button"
                        className="home-live-chip"
                        onClick={() => {
                          if (job.groupId) void selectGroup(job.groupId, true, false, true);
                          else if (owner) void select(owner.id);
                          openJob(job.id);
                        }}
                      >
                        {owner ? <Avatar sprite={owner.sprite} size={24} /> : null}
                        <span className="home-live-txt">
                          <strong>{job.title}</strong>
                          <small>{owner?.name ?? job.assistantId}</small>
                        </span>
                        <Icon name="spin" size={13} className="spin" />
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
