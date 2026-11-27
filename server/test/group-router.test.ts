import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { GroupItem } from "../../shared/types.ts";
import { decideGroupTargets, parseAutoRouteDecision } from "../src/group-router.ts";
import { makeHob, text, waitFor } from "./helpers.ts";

const fallback = { targets: ["hob"], all: false, confidence: 0, fallback: true };
const parse = (value: string) => parseAutoRouteDecision(value, ["product", "hob", "legal"], "hob");

describe("自动选人的 JSON 决策", () => {
  it("支持阈值上的单人结果以及有序、去重的多人结果", () => {
    expect(parse('{"targets":["legal"],"confidence":0.6}')).toEqual({ targets: ["legal"], all: false, confidence: 0.6, fallback: false });
    expect(parse('{"targets":["legal","unknown","product","legal"],"confidence":0.9}'))
      .toEqual({ targets: ["legal", "product"], all: false, confidence: 0.9, fallback: false });
  });

  it("识别全员与被代码围栏、说明文字包裹的对象", () => {
    expect(parse('建议如下：\n```json\n{"targets":["__all__"],"confidence":0.92,"extra":{"note":"引号 \\" 和括号 }"}}\n```\n完毕。'))
      .toEqual({ targets: ["hob"], all: true, confidence: 0.92, fallback: false });
    expect(parse('正文 {"targets":["product"],"confidence":0.8} 后续 {"targets":["legal"],"confidence":0.9}').targets).toEqual(["product"]);
  });

  it("回退处理低置信度、非有限置信度、非法 JSON 和非法目标", () => {
    for (const value of [
      '{"targets":["legal"],"confidence":0.59}',
      '{"targets":["legal"],"confidence":1e999}',
      '{"targets":["legal"],"confidence":"0.9"}',
      '{"targets":["legal"],"confidence":0.9',
      '{bad JSON}',
      '{"targets":"legal","confidence":0.9}',
      '{"targets":["",3,"__all__"],"confidence":0.9}',
    ]) expect(parse(value)).toEqual(fallback);
    for (const targets of [[], ["unknown"]]) {
      expect(parse(JSON.stringify({ targets, confidence: 0.95 }))).toEqual({ ...fallback, confidence: 0.95 });
    }
  });
});

function setup(followUpSuggestions = true) {
  const hob = makeHob({}, { memory: "off", followUpSuggestions });
  const { runtime } = hob;
  const owner = runtime.store.assistant("hob")!;
  runtime.store.saveAssistant({ ...owner, id: "product", name: "产品", duty: "梳理需求", primary: false });
  runtime.store.saveAssistant({ ...owner, id: "legal", name: "法务", duty: "审核合同条款", primary: false });
  vi.spyOn(runtime.router, "generateSuggestionsFor").mockResolvedValue(undefined);
  const group = runtime.groups.create({ name: "顾问团", purpose: "评估合作", ownerId: "hob", members: ["product", "hob", "legal"], replyMode: "auto" });
  const speakers = () => runtime.store.groupItems(group.id).filter((item) => item.kind === "assistant").map((item) => item.speaker);
  return { ...hob, group, speakers };
}

describe("自动选人的群聊波次", () => {
  it("关闭推荐提问时仍按消息选择成员", async () => {
    const { runtime, group, speakers, faux, close } = setup(false);
    try {
      faux.setResponses([text('{"targets":["legal"],"confidence":0.95}'), text("我来审核合同")]);
      await runtime.groups.send(group.id, { text: "请审核合同" });
      await waitFor(() => speakers().length > 0 && !runtime.groups.summary(group.id).busy.length);
      expect(speakers()).toEqual(["legal"]);
      expect(faux.state.callCount).toBe(2);
    } finally { close(); }
  });

  it("选人途中关闭再打开话题，不执行迟到的结果", async () => {
    const { runtime, group, faux, close } = setup();
    const finish = Promise.withResolvers<void>();
    try {
      const topic = runtime.groups.createTopic(group.id, "合同", "user");
      faux.setResponses([async () => { await finish.promise; return text('{"targets":["legal"],"confidence":0.95}'); }]);
      const sent = runtime.groups.send(topic.id, { text: "核对合同" });
      await waitFor(() => faux.state.callCount === 1);
      runtime.groups.closeByUser(topic.id, "结束");
      runtime.groups.reopen(topic.id);
      finish.resolve();
      await sent;
      expect(await runtime.groups.resumeQueue(topic.id)).toBe(false);
      expect(runtime.groups.summary(topic.id).queue).toBeUndefined();
      expect(faux.state.callCount).toBe(1);
    } finally { finish.resolve(); close(); }
  });

  it("单成员直接选群主，无需加载模型", async () => {
    const { runtime, group, close } = setup();
    try {
      const models = vi.spyOn(runtime.models, "get");
      const item: GroupItem = { id: "user-1", kind: "user", speaker: "user", text: "你好", at: new Date().toISOString() };
      expect(await decideGroupTargets(runtime, { ...group, members: ["hob"] }, item)).toEqual({ targets: ["hob"], all: false, confidence: 1, fallback: false });
      expect(models).not.toHaveBeenCalled();
    } finally { close(); }
  });

  it("先发出用户条目，带最近对话和成员职责选择法务", async () => {
    const { runtime, group, speakers, faux, close } = setup();
    const events: string[] = [];
    const off = runtime.bus.subscribe((ev) => {
      if (ev.type === "group-item" && ev.item.kind === "user") events.push(ev.item.text);
    });
    try {
      runtime.store.appendGroupItem(group.id, { id: "previous", kind: "assistant", speaker: "product", text: "采购方案已经定了", at: new Date().toISOString() });
      let context = "";
      let emitted = false;
      faux.setResponses([
        (ctx) => {
          context = JSON.stringify(ctx);
          emitted = events.includes("看看免责条款");
          return text('{"targets":["legal"],"confidence":0.9}');
        },
        text("免责范围需要收窄。"),
      ]);
      await runtime.groups.send(group.id, { text: "看看免责条款" });
      await waitFor(() => speakers().length === 2 && !runtime.groups.summary(group.id).busy.length);
      expect(emitted).toBe(true);
      expect(context).toContain("评估合作");
      expect(context).toContain("legal：法务，审核合同条款");
      expect(context).toContain("群主");
      expect(context).toContain("采购方案已经定了");
      expect(context.match(/看看免责条款/g)).toHaveLength(1);
      expect(speakers()).toEqual(["product", "legal"]);
    } finally { off(); close(); }
  });

  it("全员决定沿用顺序波次，成员看得到前一位的回复", async () => {
    const { runtime, group, speakers, faux, close } = setup();
    try {
      const prior: string[] = [];
      faux.setResponses([
        text('{"targets":["__all__"],"confidence":0.95}'),
        (ctx) => { prior.push(JSON.stringify(ctx.messages)); return text("群主意见：先评估。"); },
        (ctx) => { prior.push(JSON.stringify(ctx.messages)); return text("产品意见：先列需求。"); },
        (ctx) => { prior.push(JSON.stringify(ctx.messages)); return text("法务意见：核实责任。"); },
      ]);
      await runtime.groups.send(group.id, { text: "都谈谈这次合作" });
      await waitFor(() => speakers().length === 3 && !runtime.groups.summary(group.id).busy.length);
      expect(speakers()).toEqual(["hob", "product", "legal"]);
      expect(prior[1]).toContain("群主意见：先评估。");
      expect(prior[2]).toContain("产品意见：先列需求。");
    } finally { close(); }
  });

  it("显式点名和引用优先，跳过自动选人", async () => {
    const { runtime, group, speakers, faux, close } = setup();
    try {
      faux.setResponses([text("我来审合同。"), text("先核实免责条款。")]);
      await runtime.groups.send(group.id, { text: "@法务 看一下合同" });
      await waitFor(() => speakers().length === 1 && !runtime.groups.summary(group.id).busy.length);
      const reply = runtime.store.groupItems(group.id).find((item) => item.kind === "assistant")!;
      await runtime.groups.send(group.id, { text: "先看哪里？", quote: { itemId: reply.id, text: "我来审合同。" } });
      await waitFor(() => speakers().length === 2 && !runtime.groups.summary(group.id).busy.length);
      expect(speakers()).toEqual(["legal", "legal"]);
      expect(faux.state.callCount).toBe(2);
    } finally { close(); }
  });

  it.each([
    ["低置信度", text('{"targets":["legal"],"confidence":0.59}')],
    ["模型报错", fauxAssistantMessage("模型出错", { stopReason: "error" })],
    ["响应中止", fauxAssistantMessage("模型中止", { stopReason: "aborted" })],
    ["超时", () => new Promise<never>(() => {})],
  ] as const)("%s 时由群主接手", async (_reason, response) => {
    const { runtime, group, speakers, faux, close } = setup();
    try {
      faux.setResponses([response, text("我来接手。")]);
      await runtime.groups.send(group.id, { text: "看看这个" });
      await waitFor(() => speakers().length === 1 && !runtime.groups.summary(group.id).busy.length);
      expect(speakers()).toEqual(["hob"]);
    } finally { close(); }
  });

  it("停止期间收到路由结果，保留用户条目并跳过波次", async () => {
    const { runtime, group, speakers, faux, close } = setup();
    try {
      let release!: () => void;
      const routing = new Promise<void>((started) => {
        faux.setResponses([async () => {
          started();
          await new Promise<void>((resolve) => { release = resolve; });
          return text('{"targets":["legal"],"confidence":0.95}');
        }]);
      });
      const sent = runtime.groups.send(group.id, { text: "请审核条款" });
      await routing;
      await runtime.groups.stop(group.id);
      release();
      expect(await sent).toMatchObject({ kind: "user", text: "请审核条款" });
      expect(runtime.store.groupItems(group.id).some((item) => item.kind === "user")).toBe(true);
      expect(runtime.groups.summary(group.id).busy).toEqual([]);
      expect(await runtime.groups.resumeQueue(group.id)).toBe(false);
      expect(speakers()).toEqual([]);
      expect(faux.state.callCount).toBe(1);
    } finally { close(); }
  });

  it("自动选人请求包含成员详细职责，且路由等待期间发「先停一下」会取消本次自动选人", async () => {
    const { runtime, group, speakers, faux, close } = setup();
    try {
      const legal = runtime.store.assistant("legal")!;
      runtime.store.saveAssistant({ ...legal, dutyLong: "专门审核 NDA、服务协议与合规风险条款" });
      let seenPrompt = "";
      let release!: () => void;
      const routing = new Promise<void>((started) => {
        faux.setResponses([async (context) => {
          seenPrompt = JSON.stringify(context.messages);
          started();
          await new Promise<void>((resolve) => { release = resolve; });
          return text('{"targets":["legal"],"confidence":0.95}');
        }]);
      });
      const sent = runtime.groups.send(group.id, { text: "帮忙看看这份 NDA" });
      await routing;
      await runtime.groups.send(group.id, { text: "先停一下" });
      release();
      await sent;
      expect(seenPrompt).toContain("专门审核 NDA、服务协议与合规风险条款");
      expect(runtime.groups.summary(group.id).queue).toBeUndefined();
      expect(await runtime.groups.resumeQueue(group.id)).toBe(false);
      expect(speakers()).toEqual([]);
      expect(faux.state.callCount).toBe(1);
    } finally { close(); }
  });
});
