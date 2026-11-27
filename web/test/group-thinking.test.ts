import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import "../src/i18n/en/index.ts";
import { groupThinkingText, queuedMembersLabel } from "../src/group-thinking.ts";

afterEach(() => setLocale("zh-CN"));

describe("groupThinkingText", () => {
  it("显示成员的实时活动", () => {
    expect(groupThinkingText("开发", { label: "正在读取文件" })).toBe("开发 · 正在读取文件");
  });

  it("没有活动名称时显示思考状态，并跟随界面语言", () => {
    expect(groupThinkingText("开发")).toBe("开发 正在思考…");
    expect(groupThinkingText("开发", { label: "" })).toBe("开发 正在思考…");
    setLocale("en");
    expect(groupThinkingText("Dev", null)).toBe("Dev is thinking…");
    expect(groupThinkingText("Dev", { label: "Reading files" })).toBe("Dev · Reading files");
  });
});

describe("queuedMembersLabel", () => {
  const names: Record<string, string> = { a: "产品", b: "架构", c: "开发", d: "测试", e: "运维", f: "设计" };
  const nameOf = (id: string) => names[id] ?? id;

  it("按箭头顺序拼接排队成员并在超过 4 人时折叠", () => {
    expect(queuedMembersLabel([], nameOf)).toBe("");
    expect(queuedMembersLabel(["a"], nameOf)).toBe("产品");
    expect(queuedMembersLabel(["a", "b", "c"], nameOf)).toBe("产品 → 架构 → 开发");
    expect(queuedMembersLabel(["a", "b", "c", "d"], nameOf)).toBe("产品 → 架构 → 开发 → 测试");
    expect(queuedMembersLabel(["a", "b", "c", "d", "e", "f"], nameOf)).toBe("产品 → 架构 → 开发 → 测试 +2");
  });
});
