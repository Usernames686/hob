import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const MENU_EXIT_MS = 160;

/** 行尾的菜单向左展开（right）；行首的按钮向右展开（left）。自带触发源定位与退场过渡。 */
export function useMenu(align: "left" | "right" = "right") {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const menuRef = useRef<{ id: string; anchor: HTMLElement } | null>(null);
  const leavingRef = useRef(false);
  menuRef.current = menu;
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    leavingRef.current = false;
  }, []);

  const close = useCallback(() => {
    clearTimer();
    const el = box.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMenu(null);
      return;
    }
    leavingRef.current = true;
    el.classList.add("leaving");
    timer.current = window.setTimeout(() => {
      timer.current = null;
      leavingRef.current = false;
      setMenu(null);
    }, MENU_EXIT_MS);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  useLayoutEffect(() => {
    if (!menu || !box.current) return;
    box.current.classList.remove("leaving");
    const anchor = menu.anchor.getBoundingClientRect();
    const rect = box.current.getBoundingClientRect();
    const x = align === "left" ? anchor.left : anchor.right - rect.width;
    box.current.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    // 下面放不下就开在按钮上面（比如输入框里的加号），不压住按钮，并同步触发源缩放原点
    const below = anchor.bottom + 6 + rect.height <= window.innerHeight - 8;
    box.current.style.top = `${below ? anchor.bottom + 6 : Math.max(8, anchor.top - rect.height - 6)}px`;
    box.current.style.transformOrigin = `${below ? "top" : "bottom"} ${align}`;
  });
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !menu.anchor.contains(e.target as Node)) close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    };
    // 只有触发按钮跟着滚动才需要关菜单。旁边的对话可自动滚动。
    const scroll = (e: Event) => { if (e.target instanceof Node && e.target.contains(menu.anchor)) close(); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [menu, close]);
  return {
    menu, box, close,
    toggle: (id: string, anchor: HTMLElement) => {
      if (menuRef.current?.id === id && !leavingRef.current) {
        close();
        return;
      }
      clearTimer();
      setMenu({ id, anchor });
    },
  };
}
