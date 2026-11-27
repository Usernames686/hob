import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HobEvent } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { readSessionFile } from "../src/rewind.ts";
import { makeHob, text, waitFor } from "./helpers.ts";

function backupOf(file: string): string {
  const dir = join(dirname(file), ".rewind-backups");
  const name = readdirSync(dir).find((name) => name.startsWith(`${basename(file)}.`) && name.endsWith(".bak"));
  expect(name).toBeDefined();
  return readFileSync(join(dir, name!), "utf8");
}

describe("对话回退", () => {
  it("群回退备份时间线并截断会话树，清理已见位置和表情后可以继续发言", async () => {
    const hob = makeHob({}, { memory: "off" });
    const { groups, store, router, bus } = hob.runtime;
    try {
      const group = groups.create({ name: "回退测试", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const id = group.id;
      const created = groups.timeline(id)[0]!;
      const events: HobEvent[] = [];
      const off = bus.subscribe((event) => { if (event.type === "conversation-rewound") events.push(event); });
      const reply = (value: string) => waitFor(() => !router.isBusy("hob", id) && groups.timeline(id).some((item) => item.kind === "assistant" && item.text === value));
      hob.faux.setResponses([text("保留回复"), text("要删的回复"), text("回退之后的新回复")]);
      const first = await groups.send(id, { text: "保留请求" });
      await reply("保留回复");
      const keptReply = groups.timeline(id).at(-1)!;
      const cut = await groups.send(id, { text: "改写这个请求" });
      await reply("要删的回复");
      groups.react(id, "hob", "👍", first.id);
      groups.react(id, "hob", "👀", cut.id);
      store.saveGroupState(id, { seen: { hob: cut.id, other: first.id } });
      const timeline = store.groupTimelineFile(id);
      const member = store.groupMemberFile(id, "hob");
      const cutAt = Date.parse(cut.at);
      const parentBeforeCut = readSessionFile(member).entries.findLast((entry) => entry.timestamp < cut.at)!;
      const entries = [
        { type: "custom", customType: "test", id: "removed1", parentId: parentBeforeCut.id, timestamp: cut.at },
        { type: "custom", customType: "test", id: "orphan1", parentId: "removed1", timestamp: new Date(cutAt - 1).toISOString() },
        { type: "custom", customType: "test", id: "keptsib1", parentId: parentBeforeCut.id, timestamp: new Date(cutAt - 1).toISOString() },
      ];
      appendFileSync(member, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      const originalTimeline = readFileSync(timeline, "utf8");
      const originalMember = readFileSync(member, "utf8");
      expect(await groups.rewind(id, cut.id)).toEqual({ ok: true, removedCount: 2, restoredText: "改写这个请求" });
      expect(backupOf(timeline)).toBe(originalTimeline);
      expect(backupOf(member)).toBe(originalMember);
      expect(groups.timeline(id).map((item) => item.id)).toEqual([created.id, first.id, keptReply.id]);
      expect(readFileSync(timeline, "utf8").trimEnd().split("\n")).toHaveLength(3);
      expect(store.groupState(id)).toMatchObject({ seen: { hob: keptReply.id, other: first.id }, reactions: { [first.id]: { hob: "👍" } } });
      expect(store.groupState(id).reactions).not.toHaveProperty(cut.id);
      const session = readSessionFile(member);
      expect(session.header?.type).toBe("session");
      expect(session.entries.map((entry) => entry.id)).toContain("keptsib1");
      const seen = new Set<string>();
      for (const entry of session.entries) {
        expect(entry.timestamp < cut.at).toBe(true);
        if (entry.parentId) expect(seen.has(entry.parentId)).toBe(true);
        seen.add(entry.id);
      }
      expect(readFileSync(member, "utf8")).not.toContain("改写这个请求");
      expect(events).toEqual([{ type: "conversation-rewound", target: "group", id }]);
      off();

      const next = await groups.send(id, { text: "现在重新开始" });
      expect(Number(next.id.slice(2))).toBeGreaterThan(Number(cut.id.slice(2)) + 1);
      await reply("回退之后的新回复");
      expect(groups.timeline(id).flatMap((item) => item.kind === "user" || item.kind === "assistant" ? [item.text] : [])).toEqual(["保留请求", "保留回复", "现在重新开始", "回退之后的新回复"]);
    } finally {
      hob.close();
    }
  });

  it("群回退清空只在回退点之后参与过的新成员 seen 游标，避免后续发言丢掉前文", async () => {
    const hob = makeHob({}, { memory: "off" });
    const { groups, store, router } = hob.runtime;
    try {
      store.saveAssistant({
        id: "dev",
        name: "开发",
        duty: "实现功能",
        sprite: "s-code",
        createdAt: new Date().toISOString(),
      });
      const group = groups.create({ name: "游标测试", purpose: "测试", ownerId: "hob", members: ["hob", "dev"] });
      const id = group.id;
      const settled = (speaker: string, value: string) =>
        waitFor(() => !router.isBusy(speaker, id) && groups.timeline(id).some((item) => item.kind === "assistant" && item.speaker === speaker && item.text === value));
      let devPromptAfterRewind = "";
      hob.faux.setResponses([
        text("群主已定目标"),
        text("开发首次发言"),
        (ctx) => {
          devPromptAfterRewind = JSON.stringify(ctx.messages);
          return text("开发看到前文后的回复");
        },
      ]);
      await groups.send(id, { text: "先定个核心目标" });
      await settled("hob", "群主已定目标");
      const cut = await groups.send(id, { text: "@开发 来看看" });
      await settled("dev", "开发首次发言");

      expect(await groups.rewind(id, cut.id)).toEqual({ ok: true, removedCount: 2, restoredText: "@开发 来看看" });
      expect(store.groupState(id).seen?.dev).toBeUndefined();

      await groups.send(id, { text: "@开发 接着刚才的目标说" });
      await settled("dev", "开发看到前文后的回复");
      expect(devPromptAfterRewind).toContain("先定个核心目标");
      expect(devPromptAfterRewind).toContain("群主已定目标");
    } finally {
      hob.close();
    }
  });

  it("单聊回退映射真实的用户条目和 a-N 回复，接着可以重新发消息", async () => {
    const hob = makeHob({}, { memory: "off" });
    const { router, store, bus } = hob.runtime;
    try {
      const reply = (value: string) => waitFor(() => !router.isBusy("hob") && router.items("hob").items.some((item) => item.kind === "assistant" && item.text === value));
      const events: HobEvent[] = [];
      const off = bus.subscribe((event) => { if (event.type === "conversation-rewound") events.push(event); });
      hob.faux.setResponses([text("原来的答案"), text("删掉的答案"), text("重新回答")]);
      const first = await router.send("hob", { text: "原来的问题" });
      await reply("原来的答案");
      const cut = await router.send("hob", { text: "这条要改" });
      await reply("删掉的答案");
      const file = store.routerFile("hob");
      const original = readFileSync(file, "utf8");
      store.saveState("hob", { reactions: { [first.id]: { hob: "👍" }, [cut.id]: { hob: "👀" } } });
      expect(await router.rewind("hob", cut.id)).toEqual({ ok: true, removedCount: 2, restoredText: "这条要改" });
      expect(backupOf(file)).toBe(original);
      expect(store.state("hob").reactions).toEqual({ [first.id]: { hob: "👍" } });
      expect(router.items("hob").items.map(({ id }) => id)).toEqual([first.id, "a-1"]);
      expect(readFileSync(file, "utf8")).not.toContain("这条要改");

      const retry = await router.send("hob", { text: "已经改过的问题" });
      await reply("重新回答");
      expect(router.items("hob").items.map(({ id }) => id)).toEqual([first.id, "a-1", retry.id, "a-2"]);
      expect(await router.rewind("hob", "a-2")).toEqual({ ok: true, removedCount: 1 });
      expect(router.items("hob").items.map(({ id }) => id)).toEqual([first.id, "a-1", retry.id]);
      expect(readSessionFile(file).header?.type).toBe("session");
      expect(events).toEqual(Array.from({ length: 2 }, () => ({ type: "conversation-rewound", target: "assistant", id: "hob" })));
      off();
    } finally {
      hob.close();
    }
  });

  it("HTTP：缺少条目 ID 为 400，找不到会话或条目为 404，有效条目返回结果", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { groups, router } = hob.runtime;
      const group = groups.create({ name: "HTTP", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const user = groups.appendItem(group.id, "user", { kind: "user", text: "组内问题" });
      hob.faux.setResponses([text("单聊回答")]);
      const assistantUser = await router.send("hob", { text: "单聊问题" });
      await waitFor(() => router.items("hob").items.some((item) => item.kind === "assistant" && item.text === "单聊回答"));
      const app = createApp(hob.runtime, { home: hob.home });
      const bodyHeaders = { "content-type": "application/json" };
      const login = await app.request("/api/login", { method: "POST", headers: bodyHeaders, body: JSON.stringify({ password: "test" }) });
      const headers = { ...bodyHeaders, cookie: login.headers.get("set-cookie")!.split(";")[0]! };
      const post = (type: string, id: string, body: unknown) => app.request(`/api/${type}/${id}/rewind`, { method: "POST", headers, body: JSON.stringify(body) });
      for (const [type, id] of [["groups", group.id], ["assistants", "hob"]] as const) {
        expect((await post(type, id, {})).status).toBe(400);
        expect((await post(type, id, null)).status).toBe(400);
        expect((await post(type, id, { beforeItemId: 17 })).status).toBe(400);
        expect((await post(type, id, { beforeItemId: "missing" })).status).toBe(404);
        expect((await post(type, "missing", { beforeItemId: "g-1" })).status).toBe(404);
      }
      expect(await (await post("groups", group.id, { beforeItemId: user.id })).json()).toEqual({ ok: true, removedCount: 1, restoredText: "组内问题" });
      expect(await (await post("assistants", "hob", { beforeItemId: assistantUser.id })).json()).toEqual({ ok: true, removedCount: 2, restoredText: "单聊问题" });
      const creationNote = groups.timeline(group.id)[0]!;
      expect(await (await post("groups", group.id, { beforeItemId: creationNote.id })).json()).toEqual({ ok: true, removedCount: 1 });
      expect(readFileSync(hob.runtime.store.groupTimelineFile(group.id), "utf8")).toBe("");
      expect(router.items("hob").items).toEqual([]);
    } finally {
      hob.close();
    }
  });
});
