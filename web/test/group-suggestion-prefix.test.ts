import { describe, expect, it } from "vitest";
import { groupSuggestionPrefix } from "../src/mention.ts";

const assistants = [
  { id: "po", name: "产品负责人" },
  { id: "release", name: "发布" },
];

const items = [
  { kind: "assistant", speaker: "po" },
  { kind: "assistant", speaker: "release" },
];

const baseGroup = { ownerId: "po" };

describe("groupSuggestionPrefix", () => {
  it("群主回应模式下，最后发言人不是群主时补 @ 成员名", () => {
    expect(groupSuggestionPrefix({ ...baseGroup, replyMode: "owner" }, items, assistants)).toBe("@发布 ");
    expect(groupSuggestionPrefix(baseGroup, items, assistants)).toBe("@发布 ");
  });

  it("全员回应模式下不自动补 @ 成员名，避免退化为只点名最后一人", () => {
    expect(groupSuggestionPrefix({ ...baseGroup, replyMode: "all" }, items, assistants)).toBe("");
  });

  it("自动选人时向上一位回应的非群主成员继续追问", () => {
    expect(groupSuggestionPrefix({ ...baseGroup, replyMode: "auto" }, items, assistants)).toBe("@发布 ");
  });

  it("最后发言人是群主时不补 @", () => {
    expect(groupSuggestionPrefix({ ...baseGroup, replyMode: "owner" }, [items[0]!], assistants)).toBe("");
  });
});
