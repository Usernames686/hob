import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryDir } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import {
  addLongTermMemory,
  addScratchpadItem,
  clearDoneScratchpad,
  deleteDailyMemory,
  deleteLongTermMemory,
  deleteScratchpadItem,
  isValidDailyDate,
  MAX_MEMORY_BYTES,
  readLocalMemory,
  updateLongTermMemory,
  updateScratchpadItem,
} from "../src/local-memory.ts";
import { makeHob } from "./helpers.ts";

describe("本地记忆读写（兼容 pi-memory 格式）", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hob-local-mem-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("解析未带时间戳的段落与 pi-memory 带注释块，并支持增删改与并发 ID 防护", () => {
    const dir = memoryDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "MEMORY.md"),
      [
        "第一段未打标签的手写记忆。",
        "",
        "第二段未打标签的手写记忆。",
        "",
        "<!-- 2026-11-24 09:30:00 [user] -->",
        "回复尽量精简",
        "日期用 24 小时制",
        "",
        "<!-- last updated: 2026-11-25 18:12:34 [abc12345] -->",
        "项目使用 TypeScript + Vite",
        "",
        "<!-- HANDOFF 2026-11-26 08:00:00 [deadbeef] -->",
        "待确认发布窗口",
        "",
      ].join("\n"),
      "utf8",
    );

    const view = readLocalMemory(home);
    expect(view.longTerm).toHaveLength(5);
    expect(view.longTerm[0]).toMatchObject({ text: "第一段未打标签的手写记忆。" });
    expect(view.longTerm[0]?.updatedAt).toBeUndefined();
    expect(view.longTerm[1]).toMatchObject({ text: "第二段未打标签的手写记忆。" });
    expect(view.longTerm[2]).toMatchObject({
      text: "回复尽量精简\n日期用 24 小时制",
      updatedAt: "2026-11-24 09:30:00",
      source: "user",
    });
    expect(view.longTerm[3]).toMatchObject({
      text: "项目使用 TypeScript + Vite",
      updatedAt: "2026-11-25 18:12:34",
      source: "abc12345",
    });
    expect(view.longTerm[4]).toMatchObject({
      text: "待确认发布窗口",
      updatedAt: "2026-11-26 08:00:00",
      source: "deadbeef",
    });

    // 新增一条长期记忆：按 pi-memory 格式追加时间戳注释
    const afterAdd = addLongTermMemory(home, "  偏好乌龙茶  ");
    expect(afterAdd.longTerm).toHaveLength(6);
    const added = afterAdd.longTerm[5]!;
    expect(added.text).toBe("偏好乌龙茶");
    expect(added.source).toBe("user");
    expect(added.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const rawAfterAdd = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(rawAfterAdd).toMatch(/<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[user\] -->\n偏好乌龙茶\n$/);

    // 编辑一条记忆：更新注释为 last updated
    const targetId = afterAdd.longTerm[2]!.id;
    const afterEdit = updateLongTermMemory(home, targetId, "回复精简，24 小时制");
    expect(afterEdit).toBeDefined();
    expect(afterEdit!.longTerm[2]?.text).toBe("回复精简，24 小时制");
    const rawAfterEdit = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(rawAfterEdit).toMatch(/<!-- last updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[user\] -->\n回复精简，24 小时制/);

    // 用旧 ID 再次编辑/删除会因为内容变化而安全返回 undefined
    expect(updateLongTermMemory(home, targetId, "不应该覆盖")).toBeUndefined();
    expect(deleteLongTermMemory(home, targetId)).toBeUndefined();

    // 使用新 ID 删除
    const afterDelete = deleteLongTermMemory(home, afterEdit!.longTerm[2]!.id);
    expect(afterDelete).toBeDefined();
    expect(afterDelete!.longTerm).toHaveLength(5);
    expect(afterDelete!.longTerm.some((item) => item.text.includes("24 小时制"))).toBe(false);
  });

  it("备忘清单增改切删与清理已完成，同时完整保留非清单行", () => {
    const dir = memoryDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SCRATCHPAD.md"),
      [
        "# Scratchpad",
        "",
        "## 重要说明",
        "这段手写说明不能被删掉。",
        "",
        "<!-- 2026-11-25 10:00:00 [abc12345] -->",
        "- [ ] 第一项",
        "  附注子行",
        "<!-- 2026-11-25 11:00:00 [user] -->",
        "- [X] 第二项已完成",
        "",
      ].join("\n"),
      "utf8",
    );

    const initial = readLocalMemory(home);
    expect(initial.scratchpad).toHaveLength(2);
    expect(initial.scratchpad[0]).toMatchObject({ text: "第一项", done: false, updatedAt: "2026-11-25 10:00:00" });
    expect(initial.scratchpad[1]).toMatchObject({ text: "第二项已完成", done: true, updatedAt: "2026-11-25 11:00:00" });

    // 新增（自动将换行展平）
    const afterAdd = addScratchpadItem(home, "第三项\n换行内容");
    expect(afterAdd.scratchpad).toHaveLength(3);
    expect(afterAdd.scratchpad[2]?.text).toBe("第三项 换行内容");

    // 切换第一项为完成并改字
    const afterToggle = updateScratchpadItem(home, afterAdd.scratchpad[0]!.id, { done: true, text: "第一项（已更新）" });
    expect(afterToggle).toBeDefined();
    expect(afterToggle!.scratchpad[0]).toMatchObject({ text: "第一项（已更新）", done: true });
    expect(readFileSync(join(dir, "SCRATCHPAD.md"), "utf8")).toContain("这段手写说明不能被删掉。");
    expect(readFileSync(join(dir, "SCRATCHPAD.md"), "utf8")).toContain("  附注子行");

    // 清理已完成（移除第一项和第二项及其时间戳注释，保留未完成的第三项和手写说明）
    const afterClear = clearDoneScratchpad(home);
    expect(afterClear.scratchpad).toHaveLength(1);
    expect(afterClear.scratchpad[0]?.text).toBe("第三项 换行内容");
    const rawAfterClear = readFileSync(join(dir, "SCRATCHPAD.md"), "utf8");
    expect(rawAfterClear).toContain("## 重要说明");
    expect(rawAfterClear).toContain("这段手写说明不能被删掉。");
    expect(rawAfterClear).not.toContain("2026-11-25 10:00:00");
    expect(rawAfterClear).not.toContain("2026-11-25 11:00:00");

    // 删除最后一条清单项（连同上方时间戳注释移除）
    const afterDelete = deleteScratchpadItem(home, afterClear.scratchpad[0]!.id);
    expect(afterDelete).toBeDefined();
    expect(afterDelete!.scratchpad).toHaveLength(0);
    const rawAfterDelete = readFileSync(join(dir, "SCRATCHPAD.md"), "utf8");
    expect(rawAfterDelete).toContain("这段手写说明不能被删掉。");
    expect(rawAfterDelete).not.toContain("第三项 换行内容");
  });

  it("每日记录按日期倒序读取，删除最后一条后清理空日期文件", () => {
    const dailyDir = join(memoryDir(home), "daily");
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(
      join(dailyDir, "2026-11-24.md"),
      "<!-- 2026-11-24 20:00:00 [user] -->\n旧的一天\n",
      "utf8",
    );
    writeFileSync(
      join(dailyDir, "2026-11-26.md"),
      "<!-- 2026-11-26 09:00:00 [user] -->\n上午记录\n\n<!-- 2026-11-26 15:00:00 [s1] -->\n下午记录\n",
      "utf8",
    );
    writeFileSync(join(dailyDir, "not-a-date.md"), "忽略我\n", "utf8");

    const view = readLocalMemory(home);
    expect(view.dailyDates).toEqual(["2026-11-26", "2026-11-24"]);
    expect(view.dailyDate).toBe("2026-11-26");
    expect(view.daily.map((d) => d.text)).toEqual(["上午记录", "下午记录"]);

    const older = readLocalMemory(home, "2026-11-24");
    expect(older.dailyDate).toBe("2026-11-24");
    expect(older.daily.map((d) => d.text)).toEqual(["旧的一天"]);

    // 删除 2026-11-24 的唯一一条后，文件被删除
    const afterDelOld = deleteDailyMemory(home, "2026-11-24", older.daily[0]!.id);
    expect(afterDelOld).toBeDefined();
    expect(afterDelOld!.dailyDates).toEqual(["2026-11-26"]);
    expect(existsSync(join(dailyDir, "2026-11-24.md"))).toBe(false);
  });

  it("拒绝非法日期、路径穿越、符号链接和超大文件", () => {
    expect(isValidDailyDate("2026-11-26")).toBe(true);
    expect(isValidDailyDate("2026-02-29")).toBe(false);
    expect(isValidDailyDate("../MEMORY")).toBe(false);
    expect(() => readLocalMemory(home, "../etc/passwd")).toThrow("日期格式无效");
    expect(() => deleteDailyMemory(home, "2026-02-30", "dy-0-12345678")).toThrow("日期格式无效");

    // 符号链接文件拒绝读取和写入
    const dir = memoryDir(home);
    mkdirSync(dir, { recursive: true });
    const outside = join(home, "outside.md");
    writeFileSync(outside, "机密\n", "utf8");
    symlinkSync(outside, join(dir, "MEMORY.md"));
    expect(() => readLocalMemory(home)).toThrow("符号链接");
    expect(() => addLongTermMemory(home, "新内容")).toThrow("符号链接");

    // 移除符号链接后测试超过 512 KiB
    rmSync(join(dir, "MEMORY.md"));
    writeFileSync(join(dir, "MEMORY.md"), "x".repeat(MAX_MEMORY_BYTES + 1), "utf8");
    expect(() => readLocalMemory(home)).toThrow("512 KiB");
  });
});

describe("本地记忆 HTTP 接口", () => {
  async function signedIn(hob: ReturnType<typeof makeHob>) {
    const app = createApp(hob.runtime, { home: hob.home });
    const response = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const req = (url: string, method = "GET", body?: unknown) =>
      app.request(url, {
        method,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { req };
  }

  it("完整覆盖 /api/memory/entries* 与 /api/memory/scratchpad/clear-done", async () => {
    const hob = makeHob({}, { memory: "local" });
    try {
      const { req } = await signedIn(hob);

      // 初始为空
      const emptyRes = await req("/api/memory/entries");
      expect(emptyRes.status).toBe(200);
      expect(await emptyRes.json()).toEqual({ longTerm: [], scratchpad: [], dailyDates: [], daily: [] });

      // 非法日期 -> 400
      expect((await req("/api/memory/entries?date=2026-99-99")).status).toBe(400);

      // 空内容 -> 400
      expect((await req("/api/memory/entries", "POST", { target: "long_term", text: "   " })).status).toBe(400);

      // 新增长期记忆
      const addedRes = await req("/api/memory/entries", "POST", { target: "long_term", text: "用中文回答" });
      expect(addedRes.status).toBe(200);
      const addedView = (await addedRes.json()) as { longTerm: { id: string; text: string }[] };
      expect(addedView.longTerm).toHaveLength(1);
      const ltId = addedView.longTerm[0]!.id;

      // 更新长期记忆 & 不存在的 ID 返回 404
      expect((await req("/api/memory/entries/missing-id", "PUT", { target: "long_term", text: "改" })).status).toBe(404);
      const editedRes = await req(`/api/memory/entries/${encodeURIComponent(ltId)}`, "PUT", { target: "long_term", text: "用简洁中文回答" });
      expect(editedRes.status).toBe(200);
      const editedView = (await editedRes.json()) as { longTerm: { id: string; text: string }[] };
      expect(editedView.longTerm[0]?.text).toBe("用简洁中文回答");

      // 删除长期记忆
      const deletedRes = await req(`/api/memory/entries/${encodeURIComponent(editedView.longTerm[0]!.id)}?target=long_term`, "DELETE");
      expect(deletedRes.status).toBe(200);
      expect(((await deletedRes.json()) as { longTerm: unknown[] }).longTerm).toEqual([]);

      // 备忘清单：新增、勾选、清理已完成
      const sp1 = await (await req("/api/memory/entries", "POST", { target: "scratchpad", text: "买咖啡豆" })).json() as { scratchpad: { id: string }[] };
      const sp2 = await (await req("/api/memory/entries", "POST", { target: "scratchpad", text: "备份照片" })).json() as { scratchpad: { id: string }[] };
      expect(sp2.scratchpad).toHaveLength(2);
      const toggled = await req(`/api/memory/entries/${encodeURIComponent(sp1.scratchpad[0]!.id)}`, "PUT", { target: "scratchpad", done: true });
      expect(toggled.status).toBe(200);
      const cleared = await req("/api/memory/scratchpad/clear-done", "POST");
      expect(cleared.status).toBe(200);
      const clearedView = (await cleared.json()) as { scratchpad: { id: string; text: string }[] };
      expect(clearedView.scratchpad.map((item) => item.text)).toEqual(["备份照片"]);

      // 每日记录：写入文件 -> 读取 -> 缺 date 返回 400 -> 正常删除
      const dailyDir = join(memoryDir(hob.home), "daily");
      mkdirSync(dailyDir, { recursive: true });
      writeFileSync(join(dailyDir, "2026-11-26.md"), "<!-- 2026-11-26 12:00:00 [user] -->\n今天的日志\n", "utf8");
      const dailyView = await (await req("/api/memory/entries?date=2026-11-26")).json() as { daily: { id: string; text: string }[] };
      expect(dailyView.daily).toHaveLength(1);
      expect((await req(`/api/memory/entries/${encodeURIComponent(dailyView.daily[0]!.id)}?target=daily`, "DELETE")).status).toBe(400);
      const delDaily = await req(`/api/memory/entries/${encodeURIComponent(dailyView.daily[0]!.id)}?target=daily&date=2026-11-26`, "DELETE");
      expect(delDaily.status).toBe(200);
      expect(((await delDaily.json()) as { dailyDates: string[] }).dailyDates).toEqual([]);
    } finally {
      hob.close();
    }
  });
});
