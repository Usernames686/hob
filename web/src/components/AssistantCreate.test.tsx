import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantNameError } from "../../../shared/assistant-create.ts";
import { setLocale } from "../../../shared/i18n.ts";
import { PET_COLOR_IDS, PET_SHAPE_IDS } from "../../../shared/pet.ts";
import "../i18n/en/index.ts";
import { createMock } from "../mock.ts";
import { NewAssistantDialog } from "./AssistantCreate.tsx";
import { PetPicker } from "./PetPicker.tsx";

vi.mock("../store.ts", () => ({ useApp: () => ({ assistants: [] }), createAssistant: vi.fn(), newAssistant: vi.fn() }));
vi.mock("react-dom", async (load) => ({ ...await load<typeof import("react-dom")>(), createPortal: (node: unknown) => node }));
afterEach(() => { setLocale("zh-CN"); vi.unstubAllGlobals(); });

describe("手动新建助手", () => {
  it("表单提供两种创建入口，初始收起造型与更多选项，焦点在必填名字", () => {
    vi.stubGlobal("document", { body: null });
    const html = renderToStaticMarkup(<NewAssistantDialog onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toMatch(/<input[^>]+required=""[^>]+autoFocus=""[^>]+name="name"/i);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain("pet-grid");
    expect(html).toContain("--av-size:76px");
    for (const label of ["找 Hob 聊着建", "详细职责", "补充提示词", "工作目录（可选）", "执行命令", "修改文件", "图像生成"]) expect(html).toContain(label);
    expect(html).toContain('type="submit"');
    expect(assistantNameError("   ")).toBeTruthy();
    expect(assistantNameError("字".repeat(41))).toBeTruthy();
    expect(assistantNameError("  周报助手  ")).toBeNull();
  });

  it("展开可选全部形状、预设色与自定义色，英文模式下按钮有英文名称", () => {
    setLocale("en");
    const html = renderToStaticMarkup(<PetPicker sprite="cat:teal" onChange={() => {}} />);
    expect(html.match(/aria-pressed=/g)).toHaveLength(PET_SHAPE_IDS.length + PET_COLOR_IDS.length);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Custom color"');
    expect(html).toContain('aria-label="Cat"');
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("离线创建可搜索档案、打开会话、按中文名字查重", async () => {
    vi.stubGlobal("location", { search: "" });
    const api = createMock();
    const { assistant } = await api.createAssistant({ name: "  周报校对  ", instructions: "先给结论", sprite: "cat:#345678", abilities: { write: false } });
    expect((await api.profile(assistant.id)).assistant).toMatchObject({ name: "周报校对", sprite: "cat:#345678", instructions: "先给结论", abilities: { exec: true, write: false, image: true } });
    expect((await api.items(assistant.id)).items.at(-1)).toMatchObject({ kind: "assistant", text: expect.stringContaining("周报校对") });
    await expect(api.createAssistant({ name: "周报校对" })).rejects.toMatchObject({ status: 409 });
    await expect(api.createAssistant({ name: "新助手", sprite: "hob" })).rejects.toMatchObject({ status: 400 });
  });
});
