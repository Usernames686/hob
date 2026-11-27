// 登录页：GET /api/me 401 时显示。
import { useEffect, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { clearError, login, setLocale, useApp } from "../store.ts";

export function Login() {
  const s = useApp();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [shake, setShake] = useState(false);
  const [errSeq, setErrSeq] = useState(0);

  // 密码不对：输入框抖一下（240ms，三下）+ 宠物摇头难过
  useEffect(() => {
    if (!s.error) return;
    setShake(true);
    setErrSeq((n) => n + 1);
    const timer = window.setTimeout(() => setShake(false), 260);
    return () => window.clearTimeout(timer);
  }, [s.error]);

  const go = () => {
    if (pw && !s.loggingIn) void login(pw);
  };
  const petState = s.error ? "sad" : s.loggingIn ? "thinking" : pw.length > 0 && !show ? "shy" : "idle";
  return (
    <div className="login">
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
      >
        <Avatar
          sprite="hob"
          size={104}
          free
          live
          interactive
          follow={petState === "idle"}
          glow={Boolean(s.loggingIn)}
          petState={petState}
          action="shake"
          actionSeq={errSeq}
        />
        <div className="nm">Hob</div>
        <div className="ds">{t("请输入密码")}</div>
        <div className={`field login-field${shake ? " shake" : ""}`}>
          <input
            type={show ? "text" : "password"}
            name="password"
            aria-label={t("密码")}
            autoComplete="current-password"
            autoFocus
            value={pw}
            placeholder={t("密码")}
            onChange={(e) => {
              setPw(e.target.value);
              if (s.error) clearError();
            }}
          />
          <button
            type="button"
            className="hob-icon-btn login-eye"
            title={show ? t("隐藏密码") : t("显示密码")}
            aria-label={show ? t("隐藏密码") : t("显示密码")}
            onClick={() => setShow((v) => !v)}
          >
            <Icon name="eye" size={16} />
          </button>
        </div>
        <button type="submit" className="hob-btn hob-btn-primary" disabled={!pw || s.loggingIn}>
          {s.loggingIn ? t("正在登录…") : t("登录")}
        </button>
        <button className="lang" type="button" onClick={() => setLocale(s.locale === "en" ? "zh-CN" : "en", false)}>
          {s.locale === "en" ? "中文" : "English"}
        </button>
        {s.error ? (
          <div className="err" role="alert" style={{ width: "100%" }}>
            {s.error}
          </div>
        ) : null}
      </form>
    </div>
  );
}
