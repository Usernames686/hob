import { describe, expect, it, vi } from "vitest";
import { parsePetDirect, resolvePet } from "../../shared/pet.ts";
import type { AssistantSummary } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { seedModels } from "../src/settings.ts";
import { makeHob, text, type MakeHobOptions } from "./helpers.ts";

async function setup(settings?: MakeHobOptions["settings"]) {
  const hob = makeHob({}, { memory: "off", settings });
  const app = createApp(hob.runtime, { home: hob.home });
  const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
  const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie")!.split(";")[0] };
  const create = (body: unknown) => app.request("/api/assistants", { method: "POST", headers, body: JSON.stringify(body) });
  return { ...hob, app, create, headers };
}

describe("POST /api/assistants", () => {
  it("保存手动填写的档案，在受限会话中写入开场白并广播新助手", async () => {
    const { runtime, app, create, headers, close, faux } = await setup();
    try {
      const updates: AssistantSummary[] = [];
      runtime.bus.subscribe(event => { if (event.type === "assistant") updates.push(event.assistant); });
      const response = await create({
        name: "  Weekly Editor  ", duty: "  写代码查 Bug，再写周报 ", dutyLong: " 整理每周开发进展 ",
        instructions: " 用列表，保留引用。 ", cwd: process.cwd(), sprite: "cat:#36c4a2", abilities: { exec: false, write: false, image: false },
      });
      expect(response.status).toBe(201);
      const { assistant } = await response.json();
      expect(assistant).toMatchObject({
        id: "weekly-editor", name: "Weekly Editor", duty: "写代码查 Bug", dutyLong: "整理每周开发进展", instructions: "用列表，保留引用。",
        cwd: process.cwd(), sprite: "cat:#36c4a2", primary: false, abilities: { exec: false, write: false, image: false },
      });
      expect(assistant.splitFrom).toBeUndefined();
      expect(updates).toContainEqual(assistant);
      expect(runtime.store.rules(assistant.id)).toEqual([]);
      expect(runtime.store.drafts()).toEqual([]);
      const items = runtime.router.items(assistant.id).items;
      expect(items).toEqual([
        expect.objectContaining({ kind: "note", text: expect.stringContaining("由你手动创建") }),
        expect.objectContaining({ kind: "assistant", text: expect.stringContaining("我是Weekly Editor") }),
      ]);
      expect(faux.state.callCount).toBe(0);
      const tools = (await runtime.router.ensure(assistant.id)).session!.getActiveToolNames();
      expect(tools).toContain("read");
      for (const tool of ["bash", "write", "edit", "generate_image"]) expect(tools).not.toContain(tool);
      runtime.router.forget(assistant.id);
      expect(runtime.router.items(assistant.id).items).toEqual(items);
      const update = await app.request("/api/assistants/weekly-editor", { method: "PATCH", headers, body: JSON.stringify({ cwd: "/other" }) });
      expect(update.status).toBe(400);
    } finally { close(); }
  });

  it("首次使用还没配模型也能创建；配好之后从原开场白接着聊", async () => {
    const { runtime, create, close, faux } = await setup({ models: seedModels() });
    try {
      const response = await create({ name: "周报助手" });
      expect(response.status).toBe(201);
      const { assistant } = await response.json();
      runtime.router.forget(assistant.id);
      const opening = runtime.router.items(assistant.id).items;
      expect(opening).toEqual([
        expect.objectContaining({ kind: "note", text: expect.stringContaining("由你手动创建") }),
        expect.objectContaining({ kind: "assistant", text: "我是周报助手，有什么想让我帮忙的？" }),
      ]);
      expect(faux.state.callCount).toBe(0);
      runtime.settings.patch(runtime.settings.get().revision, { models: seedModels({ conversation: "hob-faux/faux-1" }) });
      faux.setResponses([text("收到")]);
      await runtime.router.send(assistant.id, { text: "写周报" });
      await runtime.router.waitIdle(assistant.id);
      runtime.router.forget(assistant.id);
      expect(runtime.router.items(assistant.id).items).toEqual([...opening,
        expect.objectContaining({ kind: "user", text: "写周报" }), expect.objectContaining({ kind: "assistant", text: "收到" }),
      ]);
    } finally { close(); }
  });

  it("最小表单分配不同头像并默认全开，中文重名和 slug 冲突返回 409", async () => {
    const { runtime, create, close } = await setup();
    try {
      const results = await Promise.all([create({ name: "周报助手" }), create({ name: " 周报助手 " })]);
      expect(results.map(r => r.status).sort()).toEqual([201, 409]);
      expect(await results.find(r => r.status === 409)!.json()).toEqual({ error: "已存在名称为「周报助手」的助手" });
      const { assistant } = await results.find(r => r.status === 201)!.json();
      expect(assistant).toMatchObject({ duty: "专属助手", abilities: { exec: true, write: true, image: true } });
      expect(parsePetDirect(assistant.sprite)).toBeDefined();
      const second = await create({ name: "Another Editor" });
      const other = (await second.json()).assistant;
      expect(resolvePet(other.sprite)).not.toEqual(resolvePet(assistant.sprite));
      expect((await create({ name: "another-editor" })).status).toBe(409);
      expect((await create({ name: "Hob" })).status).toBe(409);
      expect(runtime.router.items(assistant.id).items.at(-1)).toMatchObject({ text: "我是周报助手，有什么想让我帮忙的？" });
    } finally { close(); }
  });

  it("无效输入返回 400，会话初始化失败可以用原名重试", async () => {
    const { runtime, create, close } = await setup();
    try {
      const before = runtime.store.assistants();
      for (const body of [null, {}, { name: "  " }, { name: "字".repeat(41) }, ...[
        { sprite: "hob" }, { sprite: "hob:blue" }, { sprite: "cat:#abc" }, { sprite: "custom" }, { sprite: 12 },
        { cwd: "relative" }, { cwd: runtime.home }, { dutyLong: false }, { abilities: { exec: "false" } }, { abilities: null },
      ].map(fields => ({ name: "Editor", ...fields }))]) {
        expect((await create(body)).status).toBe(400);
      }
      expect(runtime.store.assistants()).toEqual(before);
      vi.spyOn(runtime.router, "ensure").mockRejectedValueOnce(new Error("会话打开失败"));
      expect((await create({ name: "Editor" })).status).toBe(500);
      expect(runtime.store.assistant("editor")).toBeUndefined();
      expect((await create({ name: "Editor" })).status).toBe(201);
    } finally { close(); }
  });
});
