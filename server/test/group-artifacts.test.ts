import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupDir } from "../src/config.ts";
import { artifactsBlockText, deleteGroupArtifact, listGroupArtifacts, MAX_ARTIFACT_BYTES, normalizeArtifactName, readGroupArtifact, writeGroupArtifact } from "../src/group-artifacts.ts";
import { createApp } from "../src/http.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob } from "./helpers.ts";

describe("共享白板文件", () => {
  let home: string;
  const gid = "g-main";
  const topic = "g-topic";
  const save = (name: string, content: string, title?: string) => writeGroupArtifact(home, gid, { name, title, content, updatedBy: "user" });

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "hob-artifacts-")); });
  afterEach(() => { vi.useRealTimers(); rmSync(home, { force: true, recursive: true }); });

  it("规范化 Markdown 文件名，拒绝路径、保留名、控制字符与其他后缀", () => {
    expect(normalizeArtifactName(" 需求 ")).toBe("需求.md");
    expect(normalizeArtifactName("方案.MD")).toBe("方案.MD");
    for (const name of ["", " ", "/", "a/b.md", "a\\b.md", "../x.md", "a..b.md", ".hide.md", "ARTIFACTS.JSON", "a\u0000b.md", "a\u007fb.md", "a".repeat(78)]) {
      expect(() => normalizeArtifactName(name), JSON.stringify(name)).toThrow("文档名无效");
    }
    expect(() => normalizeArtifactName("需求.txt")).toThrow("文档名请使用 .md 结尾");
  });

  it("更新标题、版本和 UTF-8 字节数，按时间排序，综合和话题独立", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T08:30:00Z"));
    expect(listGroupArtifacts(home, gid)).toEqual([]);
    expect(save("需求", "你好", "产品需求")).toMatchObject({ name: "需求.md", title: "产品需求", version: 1, size: 6, updatedBy: "user" });
    vi.setSystemTime(new Date("2026-11-04T08:34:00Z"));
    const plan = save("方案.MD", "# 方案");
    vi.setSystemTime(new Date("2026-11-04T08:35:00Z"));
    const updated = save("需求.MD", "# 定稿", " ");
    expect(updated).toMatchObject({ name: "需求.md", title: "产品需求", version: 2, size: 8 });
    expect(readGroupArtifact(home, gid, "需求")).toEqual(updated);
    expect(listGroupArtifacts(home, gid).map((entry) => entry.name)).toEqual([updated.name, plan.name]);
    expect(artifactsBlockText(home, gid, (id) => id, "Asia/Shanghai")).toBe("当前白板：需求.md（用户 16:35 更新，v2）、方案.MD（用户 16:34 更新，v1）");
    expect(readGroupArtifact(home, topic, "需求")).toBeUndefined();
    writeGroupArtifact(home, topic, { name: "需求", content: "话题自己的需求", updatedBy: "hob" });
    expect(deleteGroupArtifact(home, gid, "需求")).toBe(true);
    expect(deleteGroupArtifact(home, gid, "需求")).toBe(false);
    expect(readGroupArtifact(home, topic, "需求")?.content).toBe("话题自己的需求");
    const index = JSON.parse(readFileSync(join(groupDir(home, gid), "artifacts", "artifacts.json"), "utf8"));
    expect(index).toEqual([expect.objectContaining({ name: plan.name, size: plan.size })]);
  });

  it("索引丢失或老条目文件被移除时仍能读取现存文档", () => {
    const dir = join(groupDir(home, gid), "artifacts");
    save("保留", "旧文档");
    save("已移除", "旧文件");
    rmSync(join(dir, "已移除.md"));
    expect(listGroupArtifacts(home, gid).map((entry) => entry.name)).toEqual(["保留.md"]);
    rmSync(join(dir, "artifacts.json"));
    writeFileSync(join(dir, "导入.md"), "# 导入");
    symlinkSync(join(dir, "导入.md"), join(dir, "链接.md"));
    expect(readGroupArtifact(home, gid, "链接")).toBeUndefined();
    expect(readGroupArtifact(home, gid, "导入")).toMatchObject({ title: "导入", content: "# 导入", size: 8, version: 1 });
    expect(listGroupArtifacts(home, gid)).toHaveLength(2);
    expect(save("保留", "新内容").version).toBe(2);
  });

  it("限制写入大小并在索引替换失败时恢复原文件", () => {
    const original = "a".repeat(MAX_ARTIFACT_BYTES);
    expect(save("大文档", original).size).toBe(MAX_ARTIFACT_BYTES);
    expect(() => save("大文档", original + "你")).toThrow("文档不能超过 512 KiB");
    expect(readGroupArtifact(home, gid, "大文档")?.version).toBe(1);
    const index = join(groupDir(home, gid), "artifacts", "artifacts.json");
    rmSync(index);
    mkdirSync(index);
    expect(() => save("大文档", "新版")).toThrow();
    expect(() => save("新文档", "不能留下")).toThrow();
    expect(() => deleteGroupArtifact(home, gid, "大文档")).toThrow();
    expect(readGroupArtifact(home, gid, "大文档")?.content).toBe(original);
    expect(readGroupArtifact(home, gid, "新文档")).toBeUndefined();
  });

  it("白板提示最多列出最新 12 份", () => {
    expect(artifactsBlockText(home, gid, (id) => id, "Asia/Shanghai")).toBeUndefined();
    vi.useFakeTimers();
    for (let i = 0; i < 13; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 4, 8, i)));
      save(`文档-${i}`, "");
    }
    const line = artifactsBlockText(home, gid, (id) => id, "Asia/Shanghai");
    expect(line).toContain("当前白板：文档-12.md（用户 16:12 更新，v1）");
    expect(line).not.toContain("文档-0.md");
    expect(line).toContain("等共 13 份");
  });
});

describe("共享白板接口与工具", () => {
  it("用户与助手更新同一话题文档，推送对应话题，综合保留独立清单", async () => {
    const { runtime, home, close } = makeHob({}, { memory: "off" });
    const events: string[] = [];
    const off = runtime.bus.subscribe((ev) => { if (ev.type === "group-artifacts") events.push(ev.groupId); });
    try {
      const group = runtime.groups.create({ name: "团队", purpose: "设计", ownerId: "hob", members: ["hob"] });
      const topic = runtime.groups.createTopic(group.id, "设计评审", "user");
      const tools = buildRouterTools(runtime, "hob", topic.id);
      const write = tools.find((tool) => tool.name === "write_artifact")!;
      const read = tools.find((tool) => tool.name === "read_artifact")!;
      expect(buildRouterTools(runtime, "hob").some((tool) => tool.name.endsWith("_artifact"))).toBe(false);
      const app = createApp(runtime, { home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie")!.split(";")[0]! };
      const base = `/api/groups/${topic.id}/artifacts`;
      const path = `${base}/${encodeURIComponent("需求")}`;
      const request = (url: string, method = "GET", body?: unknown) => app.request(url, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect((await request("/api/groups/g-missing/artifacts")).status).toBe(404);
      expect((await request(`${base}/a%2Fb.md`)).status).toBe(400);
      expect((await request(path)).status).toBe(404);
      expect((await request(path, "PUT", { content: null })).status).toBe(400);
      const put = await request(path, "PUT", { title: "设计需求", content: "# 初稿" });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ artifact: { name: "需求.md", content: "# 初稿", updatedBy: "user", version: 1 } });
      expect(runtime.groups.summary(topic.id).artifactCount).toBe(1);
      expect(runtime.groups.summary(group.id).artifactCount).toBeUndefined();

      const textOf = (result: { content: { type: string }[] }) => (result.content[0] as { text?: string }).text;
      const updated = await write.execute("write", { name: "需求.md", content: "# 定稿" }, undefined, undefined, undefined as never);
      expect(textOf(updated)).toContain("v2");
      expect(runtime.groups.summary(topic.id).artifactCount).toBe(1);
      expect(runtime.groups.timeline(topic.id)).toContainEqual(expect.objectContaining({
        kind: "note",
        icon: "artifact",
        speaker: "hob",
        text: "Hob 更新了文档「设计需求」v2",
        artifact: { groupId: topic.id, name: "需求.md" },
      }));
      expect(textOf(await read.execute("read", { name: "需求" }, undefined, undefined, undefined as never))).toContain("# 定稿");
      expect(textOf(await read.execute("list", {}, undefined, undefined, undefined as never))).toContain("需求.md，v2，Hob");
      expect(textOf(await read.execute("missing", { name: "别的" }, undefined, undefined, undefined as never))).toContain("可用文档：需求.md");
      expect(await (await request(path)).json()).toMatchObject({ artifact: { title: "设计需求", content: "# 定稿", updatedBy: "hob", version: 2 } });
      const conflict = await request(path, "PUT", { content: "# 过期覆盖", expectedVersion: 1 });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ currentVersion: 2 });
      expect(await (await request(path)).json()).toMatchObject({ artifact: { content: "# 定稿", version: 2 } });
      expect(await (await request(base)).json()).toMatchObject({ artifacts: [{ name: "需求.md", version: 2 }] });
      expect(await (await request(`/api/groups/${group.id}/artifacts`)).json()).toEqual({ artifacts: [] });
      expect(await (await request(path, "DELETE")).json()).toEqual({ ok: true });
      expect(runtime.groups.summary(topic.id).artifactCount).toBeUndefined();
      expect((await request(path, "DELETE")).status).toBe(404);
      expect(textOf(await read.execute("empty", {}, undefined, undefined, undefined as never))).toBe("当前话题还没有白板文档。");
      expect(events).toEqual([topic.id, topic.id, topic.id]);
    } finally { off(); close(); }
  });
});
