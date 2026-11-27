import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatConversationMarkdown,
  safeExportFilename,
  suggestArtifactTitleAndName,
} from "../../shared/export-markdown.ts";
import { normalizeArtifactName } from "../../shared/group-artifact.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

describe("Markdown 导出与白板命名工具", () => {
  it("suggestArtifactTitleAndName 提取标题、跳过代码块、截断并生成合法文件名", () => {
    const withHeading = suggestArtifactTitleAndName(
      "```bash\n# 代码注释不是标题\n```\n\n## Q4 架构升级方案：核心模块拆分与迁移计划\n正文",
      "群聊沉淀",
    );
    expect(withHeading.title).toBe("Q4 架构升级方案：核心模块拆分与迁移计划".slice(0, 20));
    expect(withHeading.name.endsWith(".md")).toBe(true);
    expect(() => normalizeArtifactName(withHeading.name)).not.toThrow();

    const withMarkers = suggestArtifactTitleAndName(
      "> - **@产品** [需求评审/结论:v1.0](https://example.com)",
      "群聊沉淀",
    );
    expect(withMarkers.title).toContain("需求评审");
    expect(withMarkers.name).not.toMatch(/[/\\<>:"|?*]/);
    expect(() => normalizeArtifactName(withMarkers.name)).not.toThrow();

    const empty = suggestArtifactTitleAndName("   \n---\n   ", "群聊沉淀");
    expect(empty).toEqual({ title: "群聊沉淀", name: "群聊沉淀.md" });
  });

  it("safeExportFilename 过滤非法字符并附加日期后缀", () => {
    expect(safeExportFilename("技术/方案:v1.2", "2026-11-26")).toBe("技术-方案-v1-2-2026-11-26.md");
    expect(safeExportFilename("   ", "2026-11-26")).toBe("conversation-2026-11-26.md");
  });

  it("formatConversationMarkdown 格式化标题、元信息、引用与附件", () => {
    const md = formatConversationMarkdown({
      title: "Hob",
      subtitle: "主助手",
      exportedAt: "2026-11-26 14:30:00",
      messages: [
        { speaker: "用户", at: "2026-11-26 14:00:00", text: "帮我看看这份文档", files: ["需求.pdf"] },
        { speaker: "Hob", at: "2026-11-26 14:01:00", text: "已整理好要点。", quote: "帮我看看这份文档" },
      ],
    });
    expect(md).toContain("# Hob");
    expect(md).toContain("> 主助手 · 导出时间：2026-11-26 14:30:00");
    expect(md).toContain("### 用户 · 2026-11-26 14:00:00");
    expect(md).toContain("_附件：需求.pdf_");
    expect(md).toContain("### Hob · 2026-11-26 14:01:00");
    expect(md).toContain("> 引用：帮我看看这份文档");
    expect(md).toContain("\n---\n");

    const emptyMd = formatConversationMarkdown({
      title: "空对话",
      exportedAt: "2026-11-26 14:30:00",
      messages: [],
    });
    expect(emptyMd).toContain("（暂无消息）");
  });
});

describe("完整对话导出 HTTP 接口", () => {
  async function signedIn(hob: ReturnType<typeof makeHob>) {
    const app = createApp(hob.runtime, { home: hob.home });
    const response = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const get = (url: string) => app.request(url, { headers: { cookie } });
    return { get };
  }

  it("GET /api/assistants/:id/export 导出超过 50 条的完整历史并在缺失时返回 404", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { get } = await signedIn(hob);
      expect((await get("/api/assistants/not-exist/export")).status).toBe(404);

      // 直接写入 60 条对话消息（30 轮），验证不被 /items 默认 50 条截断
      const file = hob.runtime.store.routerFile("hob");
      mkdirSync(dirname(file), { recursive: true });
      const lines: string[] = [
        JSON.stringify({ type: "session", version: 3, id: "s-export", timestamp: "2026-11-26T00:00:00.000Z", cwd: hob.home }),
      ];
      let parentId: string | null = null;
      for (let i = 1; i <= 30; i++) {
        const uId = `u-${i}`;
        const aId = `a-${i}`;
        const uTs = new Date(Date.UTC(2026, 10, 26, 0, i, 0)).toISOString();
        const aTs = new Date(Date.UTC(2026, 10, 26, 0, i, 30)).toISOString();
        lines.push(JSON.stringify({
          type: "custom",
          customType: "hob.user",
          id: uId,
          parentId,
          timestamp: uTs,
          data: { text: `用户问题第 ${i} 条` },
        }));
        lines.push(JSON.stringify({
          type: "message",
          id: aId,
          parentId: uId,
          timestamp: aTs,
          message: { role: "assistant", content: [{ type: "text", text: `助手回复第 ${i} 条` }], timestamp: Date.parse(aTs) },
        }));
        parentId = aId;
      }
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

      const res = await get("/api/assistants/hob/export");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { filename: string; content: string };
      expect(data.filename).toMatch(/^Hob-\d{4}-\d{2}-\d{2}\.md$/);
      expect(data.content).toContain("# Hob");
      expect(data.content).toContain("用户问题第 1 条");
      expect(data.content).toContain("助手回复第 30 条");
      // 共 60 条消息，全部存在
      expect((data.content.match(/^### /gm) ?? []).length).toBe(60);
    } finally {
      hob.close();
    }
  });

  it.each(["单聊", "群聊"])("%s导出保留卡片摘要和没有总结的任务失败原因", async (scope) => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { get } = await signedIn(hob);
      const gid = scope === "群聊" ? hob.runtime.groups.create({ name: "核账组", purpose: "核账", ownerId: "hob", members: ["hob"] }).id : undefined;
      const createdAt = new Date().toISOString();
      hob.runtime.store.saveJob({ id: "t-export", assistantId: "hob", groupId: gid, title: "核账", instruction: "读取账本", status: "failed", statusReason: "找不到账本", createdAt, stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      await hob.runtime.router.addItem("hob", { kind: "job", jobId: "t-export" }, gid);
      await hob.runtime.router.addCard("hob", {
        id: "c-export", owner: { type: "assistant", assistantId: "hob" }, status: "done", createdAt,
        card: { header: { title: "核账单" }, config: { summary: { content: "明细已复核" } }, body: { elements: [] } },
      }, gid);
      const res = await get(gid ? `/api/groups/${gid}/export` : "/api/assistants/hob/export");
      expect(res.status).toBe(200);
      const { content } = await res.json();
      expect(content).toContain("核账\n\n找不到账本");
      expect(content).toContain("卡片「核账单」：明细已复核");
    } finally { hob.close(); }
  });

  it("GET /api/groups/:id/export 导出完整群聊与话题并在缺失时返回 404", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { get } = await signedIn(hob);
      expect((await get("/api/groups/g-missing/export")).status).toBe(404);

      const group = hob.runtime.groups.create({ name: "研发组", purpose: "技术评审", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "内存优化", "user");

      hob.runtime.store.appendGroupItem(topic.id, {
        kind: "user",
        id: "g-1",
        at: "2026-11-26T08:00:00.000Z",
        speaker: "user",
        text: "我们来排查内存占用",
      });
      hob.runtime.store.appendGroupItem(topic.id, {
        kind: "note",
        id: "g-2",
        at: "2026-11-26T08:00:10.000Z",
        speaker: "hob",
        icon: "info",
        text: "系统提示不应作为普通消息混入",
      });
      hob.runtime.store.appendGroupItem(topic.id, {
        kind: "assistant",
        id: "g-3",
        at: "2026-11-26T08:01:00.000Z",
        speaker: "hob",
        text: "先从堆快照看起。",
        quote: { itemId: "g-1", text: "我们来排查内存占用" },
      });

      const res = await get(`/api/groups/${topic.id}/export`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { filename: string; content: string };
      expect(data.filename).toMatch(/^研发组-内存优化-\d{4}-\d{2}-\d{2}\.md$/);
      expect(data.content).toContain("# 研发组 · 内存优化");
      expect(data.content).toContain("### 用户 · ");
      expect(data.content).toContain("### Hob · ");
      expect(data.content).toContain("> 引用：我们来排查内存占用");
      expect(data.content).not.toContain("系统提示不应作为普通消息混入");
    } finally {
      hob.close();
    }
  });
});
