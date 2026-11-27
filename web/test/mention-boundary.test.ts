import { describe, expect, it } from "vitest";
import { extractMentions, stripCodeForMentions } from "../../shared/mention.ts";
import { renderMarkdown } from "../src/markdown.ts";

const names = ["dev", "devOps", "家里", "家里 NAS", "测试"];
const candidates = names.map((name) => ({ id: name, name }));

describe("群点名的匹配与高亮", () => {
  it.each([
    { text: "foo@dev foo.@dev foo+@dev a%+b@devOps.example @dev_team @dev-tool", hits: [] },
    { text: "@devOps @dev @家里 NAS 请@测试看下", hits: ["devOps", "dev", "家里 NAS", "测试"] },
    { text: "(@dev) `@测试` ``有 ` 和 @devOps``\n~~~js\n@家里\n~~~~\n@测试", hits: ["dev", "测试"] },
    { text: "@测试\n````\n```\n@家里\n````\n@dev", hits: ["测试", "dev"] },
    { text: "@devOps @devOPS @dev2 @dev。\n```js\n@测试", hits: ["devOps", "dev"] },
  ])("$text", ({ text, hits }) => {
    expect(extractMentions(text, candidates)).toEqual(hits);
    const highlighted = [...renderMarkdown(text, names).matchAll(/<span class="at">@([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(highlighted).toEqual(hits);
  });

  it("重复点名只排一次，消息里的每处点名都高亮", () => {
    expect(extractMentions("@dev @测试 @dev", candidates)).toEqual(["dev", "测试"]);
    expect(renderMarkdown("@dev @测试 @dev", names).match(/<span class="at">@dev<\/span>/g)).toHaveLength(2);
    expect(stripCodeForMentions("没有闭合的 ` 后面 @dev")).toContain("@dev");
    expect(renderMarkdown("@devOps", ["dev"])).not.toContain('class="at"');
  });

  it("支持全角 ＠ 与 aliases（成员 ID）匹配，并保持英文边界保护", () => {
    const withAlias = [{ id: "dev", name: "开发", aliases: ["dev"] }, { id: "qa", name: "测试", aliases: ["qa"] }];
    expect(extractMentions("＠开发 @qa foo@dev @dev_team", withAlias)).toEqual(["dev", "qa"]);
  });
});
