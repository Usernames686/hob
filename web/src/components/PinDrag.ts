// 置顶头像与列表行拖动：置顶区内拖动换先后，往下拖出置顶区取消置顶；列表行上下拖换顺序、往上拖进置顶区置顶。
// 换位置的算法在 ../pin-drag.ts，这里只管指针、拖动中的预览和落盘。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { dropIndex, reorderAt, type Box } from "../pin-drag.ts";
import { closeAssistantMenu, getState, pinConversation, saveListOrder, savePinOrder, setHomeOrder, shallow, unpinConversation, useAppSelect, type State } from "../store.ts";

/** 拖动只在菜单开着、或者正在搜索时才改行为：切页不牵动这几行。 */
const pickMenuOpen = (s: State) => s.menu !== null;
const pickPinDrag = (s: State) => ({ menu: s.menu, query: s.query });

/** 按住后移动超过这么多像素才算在拖：点一下照旧打开对话，长按照旧弹菜单。 */
const SLOP = 6;

export interface PinHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
}

/** 一个置顶头像要接的东西：指针事件挂在头像上，抬起时的点击不算数。 */
export interface PinDragTarget {
  handlers: PinHandlers;
  takeMoved: () => boolean;
}

export interface PinDrag<T> {
  /** 包住头像那一层：从这里往下找带 data-pin 的头像格子 */
  grid: RefObject<HTMLDivElement | null>;
  /** 这一排是不是不让拖（搜索时只显示筛出来的几位，这时候排位置会把别的助手的挤掉） */
  locked: boolean;
  /** 拖动中的先后；没在拖就是传进来的先后 */
  order: T[];
  /** 正拖着的那一个助手或群 */
  lifted: string | null;
  /** 正拖到置顶区下方，松手将取消置顶 */
  unpin: boolean;
  /** 每个头像接的指针事件 */
  target: (id: string) => PinDragTarget;
  /** 包住头像那一层的类名：抬起的那一格加 lift，拖出置顶区再加 unpin */
  className: (id: string) => string | undefined;
}

interface Press {
  id: string;
  pointerId: number;
  /** 按下时的指针位置 */
  from: { x: number; y: number };
  /** 手指落在头像里的位置，拖动时这一块始终对着手指 */
  grab: { x: number; y: number };
  active: boolean;
}

/**
 * 量一格的位置。跟着指针走的那一格要先把它自己的位移拿掉再量，不然量到的是已经平移过的地方。
 */
function measure(el: HTMLElement, plain = false): Box {
  const keep = el.style.transform;
  if (plain) el.style.transform = "none";
  const r = el.getBoundingClientRect();
  if (plain) el.style.transform = keep;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** 当前可见的普通列表行（排除收起折叠区）。 */
function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".home-row[data-row]")].filter((el) => el.getBoundingClientRect().height > 0);
}

function clearRowMarks() {
  for (const el of document.querySelectorAll<HTMLElement>(".home-row.drop-before, .home-row.drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
}

/** 在列表里落到哪：插在第几行前面，画线的那一行和画在上边还是下边。 */
function rowSlot(x: number, y: number): { index: number; el: HTMLElement; after: boolean } | null {
  const list = visibleRows();
  if (!list.length) return null;
  const first = list[0].getBoundingClientRect();
  const last = list[list.length - 1].getBoundingClientRect();
  if (x < first.left - 24 || x > first.right + 24 || y < first.top - 20 || y > last.bottom + 20) return null;
  const index = list.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  return index < 0 ? { index: list.length, el: list[list.length - 1], after: true } : { index, el: list[index], after: false };
}

export function usePinDrag<T extends { id: string }>(pins: T[], locked = false, canUnpin?: (item: T) => boolean): PinDrag<T> {
  const menuOpen = useAppSelect(pickMenuOpen);
  const grid = useRef<HTMLDivElement | null>(null);
  /** 拖动中的先后（只存 id）；松手就清掉，跟着保存后的先后走 */
  const [orderIds, setOrderIds] = useState<string[] | null>(null);
  const [press, setPress] = useState<Press | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [unpin, setUnpin] = useState(false);
  /** 这次按下有没有真拖过：拖过就跟一次点击，别顺手打开对话 */
  const moved = useRef(false);

  const order = useMemo(() => {
    if (!orderIds) return pins;
    const byId = new Map(pins.map((a) => [a.id, a]));
    const out = orderIds.map((id) => byId.get(id)).filter((a): a is T => Boolean(a));
    // 拖动的同时别处加减了置顶：新来的接在后面
    for (const a of pins) if (!orderIds.includes(a.id)) out.push(a);
    return out;
  }, [orderIds, pins]);

  /** 每一格现在的位置：只认当前先后里的那几个，离场动画里的行不算。抬起的那一格按没位移的位置算。 */
  const boxes = (ids: string[]): Box[] => {
    const root = grid.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>("[data-pin]")]
      .filter((el) => ids.includes(el.dataset.pin ?? ""))
      .map((el) => measure(el, press?.id === el.dataset.pin));
  };

  useEffect(() => {
    if (!press) return;
    const current = pins.find((item) => item.id === press.id);
    const allowUnpin = Boolean(current && canUnpin?.(current));
    const inUnpinZone = (x: number, y: number) => {
      if (!allowUnpin) return false;
      const r = grid.current?.getBoundingClientRect();
      return Boolean(r && y > r.bottom + 20 && x >= r.left - 40 && x <= r.right + 40);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== press.pointerId) return;
      if (!press.active) {
        if (Math.abs(e.clientX - press.from.x) <= SLOP && Math.abs(e.clientY - press.from.y) <= SLOP) return;
        // 开始拖了：长按菜单让位
        closeAssistantMenu();
        moved.current = true;
        setPress({ ...press, active: true });
      }
      setPos({ x: e.clientX, y: e.clientY });
      const out = inUnpinZone(e.clientX, e.clientY);
      setUnpin(out);
      clearRowMarks();
      if (out) {
        const at = rowSlot(e.clientX, e.clientY);
        at?.el.classList.add(at.after ? "drop-after" : "drop-before");
        return;
      }
      const ids = orderIds ?? pins.map((a) => a.id);
      const next = reorderAt(ids, boxes(ids), press.id, e.clientX, e.clientY);
      if (next !== ids) setOrderIds(next);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== press.pointerId) return;
      const ids = orderIds ?? pins.map((a) => a.id);
      const dropped = press.active;
      const shouldUnpin = dropped && inUnpinZone(e.clientX, e.clientY);
      const at = shouldUnpin ? rowSlot(e.clientX, e.clientY) : null;
      const rowIds = at ? visibleRows().map((el) => el.dataset.row ?? "").filter((id) => id && id !== press.id) : null;
      clearRowMarks();
      setPress(null);
      setPos(null);
      setOrderIds(null);
      setUnpin(false);
      if (!dropped) return;
      if (shouldUnpin) {
        void (async () => {
          if (await unpinConversation(press.id)) return;
          if (at && rowIds) {
            const next = rowIds.slice();
            next.splice(at.index, 0, press.id);
            if (getState().homeOrder !== "custom") setHomeOrder("custom");
            await saveListOrder(next);
          }
        })();
        return;
      }
      void savePinOrder(ids);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      clearRowMarks();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [press, orderIds, pins, canUnpin]);

  // 抬起的那一格跟着指针：量它现在这一格的布局位置，再平移到手指下的位置。
  useLayoutEffect(() => {
    if (!press) return;
    const root = grid.current;
    const el = [...(root?.querySelectorAll<HTMLElement>("[data-pin]") ?? [])].find((x) => x.dataset.pin === press.id);
    if (!el) return;
    if (!press.active || !pos) {
      el.style.transform = "";
      return;
    }
    const r = measure(el, true);
    el.style.transform = `translate(${pos.x - press.grab.x - r.left}px, ${pos.y - press.grab.y - r.top}px)`;
    return () => {
      el.style.transform = "";
    };
  }, [press, pos, order]);

  const target = (id: string): PinDragTarget => ({
    handlers: {
      onPointerDown(e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        // 菜单开着：这一下算点别处关菜单，不接拖动；搜索时这一排是筛出来的几位，也不接
        if (menuOpen || locked) return;
        const el = [...(grid.current?.querySelectorAll<HTMLElement>("[data-pin]") ?? [])].find((x) => x.dataset.pin === id);
        if (!el) return;
        const r = el.getBoundingClientRect();
        moved.current = false;
        setUnpin(false);
        setPress({
          id,
          pointerId: e.pointerId,
          from: { x: e.clientX, y: e.clientY },
          grab: { x: e.clientX - r.left, y: e.clientY - r.top },
          active: false,
        });
        setPos({ x: e.clientX, y: e.clientY });
      },
    },
    takeMoved() {
      const was = moved.current;
      moved.current = false;
      return was;
    },
  });

  return {
    grid,
    locked,
    order,
    lifted: press?.active ? press.id : null,
    unpin: Boolean(press?.active && unpin),
    target,
    className: (id) => (press?.active && press.id === id ? (unpin ? "lift unpin" : "lift") : undefined),
  };
}

/**
 * 会话行（助手或群）按住拖：拖进置顶区就置顶，落在哪一格就排在哪；
 * 在列表里上下拖就换先后（自动切到固定顺序并保存 listOrder）。只接鼠标，触摸编辑时按住把手拖。
 */
export function useRowToPin(item: { id: string; pinned: boolean; hidden: boolean }, reorder = false) {
  const app = useAppSelect(pickPinDrag, shallow);
  const menuOpen = app.menu !== null;
  // 搜索时日常只显示筛出来的几位，换先后会把别的挤乱：只许拖进置顶
  const searching = app.query.trim().length > 0;
  const [press, setPress] = useState<{ pointerId: number; from: { x: number; y: number }; active: boolean } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; over: boolean } | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (!press) return;
    const grid = () => document.querySelector<HTMLElement>(".pins:not(.locked), .mpins:not(.locked)");
    const over = (x: number, y: number) => {
      const r = grid()?.getBoundingClientRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top - 12 && y <= r.bottom + 12;
    };
    const clearMarks = () => {
      grid()?.classList.remove("drop");
      clearRowMarks();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== press.pointerId) return;
      if (!press.active) {
        if (Math.abs(e.clientX - press.from.x) <= SLOP && Math.abs(e.clientY - press.from.y) <= SLOP) return;
        closeAssistantMenu();
        moved.current = true;
        setPress({ ...press, active: true });
      }
      const hit = over(e.clientX, e.clientY);
      clearMarks();
      if (hit) grid()?.classList.add("drop");
      else if (!searching && !item.hidden) {
        const at = rowSlot(e.clientX, e.clientY);
        if (at) {
          const ids = visibleRows().map((el) => el.dataset.row ?? "");
          const from = ids.indexOf(item.id);
          if (from < 0 || (at.index !== from && at.index !== from + 1)) {
            at.el.classList.add(at.after ? "drop-after" : "drop-before");
          }
        }
      }
      setPos({ x: e.clientX, y: e.clientY, over: hit });
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== press.pointerId) return;
      const root = grid();
      clearMarks();
      setPress(null);
      setPos(null);
      if (!press.active) return;
      if (!root || !over(e.clientX, e.clientY)) {
        if (searching || item.hidden) return;
        const at = rowSlot(e.clientX, e.clientY);
        if (!at) return;
        const ids = visibleRows().map((el) => el.dataset.row ?? "");
        const from = ids.indexOf(item.id);
        if (from < 0) return;
        const to = at.index > from ? at.index - 1 : at.index;
        if (to === from) return;
        const next = ids.filter((id) => id !== item.id);
        next.splice(to, 0, item.id);
        if (getState().homeOrder !== "custom") setHomeOrder("custom");
        void saveListOrder(next);
        return;
      }
      const cells = [...root.querySelectorAll<HTMLElement>("[data-pin]")];
      const ids = cells.map((el) => el.dataset.pin ?? "");
      const at = dropIndex(cells.map((el) => measure(el)), e.clientX, e.clientY);
      // 落在那一格的右半边就排在它后面
      const r = at < 0 ? null : cells[at].getBoundingClientRect();
      const index = at < 0 ? ids.length : e.clientX > r!.left + r!.width / 2 ? at + 1 : at;
      void (async () => {
        if (await pinConversation(item.id)) return;
        await savePinOrder([...ids.slice(0, index), item.id, ...ids.slice(index)]);
      })();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      clearMarks();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [press, item.id, item.hidden, searching]);

  return {
    onPointerDown(e: ReactPointerEvent) {
      // 触摸只在编辑时按住把手才拖，别处照常滚动
      const onGrip = e.target instanceof Element && e.target.closest(".grip") !== null;
      if (e.pointerType !== "mouse" && !(reorder && onGrip) || e.pointerType === "mouse" && e.button !== 0 || menuOpen) return;
      moved.current = false;
      setPress({ pointerId: e.pointerId, from: { x: e.clientX, y: e.clientY }, active: false });
    },
    /** 拖着走的那个小头像的位置；没在拖是 null */
    ghost: press?.active && pos ? pos : null,
    takeMoved() {
      const was = moved.current;
      moved.current = false;
      return was;
    },
  };
}
