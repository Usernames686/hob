import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

function keepFocusInDialog(event: ReactKeyboardEvent<HTMLFormElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]"))
    .filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[inert]") && el.getClientRects().length);
  const first = controls[0];
  const last = controls.at(-1);
  if (event.target !== (event.shiftKey ? first : last)) return;
  event.preventDefault();
  (event.shiftKey ? last : first)?.focus();
}

export function DialogShell({ label, title, className = "", dismissible = true, onClose, onSubmit, children, actions }: { label: string; title: string; className?: string; dismissible?: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode; actions: ReactNode }) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | null>(null);
  const closeSmooth = useCallback(() => {
    if (!dismissible || leaving) return;
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }
    setLeaving(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onClose();
    }, 155);
  }, [dismissible, leaving, onClose]);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeSmooth();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeSmooth]);
  const backdrop = (event: PointerEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) closeSmooth(); };
  return createPortal(<div className={`gcreate${leaving ? " leaving" : ""}`} role="dialog" aria-modal="true" aria-label={label} onPointerDown={backdrop}>
    <form className={`gcreate-card${className ? ` ${className}` : ""}`} noValidate onSubmit={onSubmit} onKeyDown={keepFocusInDialog}>
      <div className="gcreate-title">{title}</div>{children}<div className="gcreate-acts">{actions}</div>
    </form>
  </div>, document.body);
}
