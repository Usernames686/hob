import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../../server/src/http.ts";
import { makeHob, type TestHob } from "../../server/test/helpers.ts";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base: string;
let hob: TestHob;

beforeAll(async () => {
  hob = makeHob({}, { memory: "off" });
  const api = getRequestListener(createApp(hob.runtime, { home: hob.home }).fetch);
  server = await createServer({
    server: { port: 0, host: "127.0.0.1" },
    plugins: [{ name: "hob-test-api", configureServer(vite) {
      vite.middlewares.use((req, res, next) => req.url?.startsWith("/api/") ? api(req, res) : next());
    } }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
});

afterAll(async () => { await browser?.close(); await server?.close(); hob?.close(); });

describe("桌面助手资料", () => {
  it("从左栏手动创建，另一窗口能实时打开同一对话", async () => {
    const login = await page.request.post(`${base}/api/login`, { data: { password: "test" } });
    expect(login.ok()).toBe(true);
    const other = await page.context().newPage();
    other.setDefaultTimeout(10_000);
    await Promise.all([page.goto(base), other.goto(base)]);
    await other.getByRole("button", { name: "新建助手或建群" }).waitFor();
    await page.getByRole("button", { name: "新建助手或建群" }).click();
    await page.getByRole("menuitem", { name: "新建助手" }).click();
    const dialog = page.getByRole("dialog", { name: "新建助手" });
    const name = dialog.getByRole("textbox", { name: "名字", exact: true });
    const create = dialog.getByRole("button", { name: "创建", exact: true });
    expect(await name.evaluate(el => el === document.activeElement)).toBe(true);
    await create.focus();
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Shift+Tab");
    expect(await create.evaluate(el => el === document.activeElement)).toBe(true);

    await name.fill("   ");
    await create.click();
    expect(await dialog.getByRole("alert").innerText()).toBe("请为助手命名。");
    await name.fill("Hob");
    await create.click();
    expect(await dialog.getByRole("alert").innerText()).toContain("已存在");
    expect(await name.inputValue()).toBe("Hob");
    await name.fill("桌面周报助手");
    await create.click();
    await page.getByRole("main").getByText("我是桌面周报助手，有什么想让我帮忙的？", { exact: true }).waitFor();
    expect(await dialog.count()).toBe(0);
    await other.getByRole("button", { name: /桌面周报助手/ }).click();
    await other.getByRole("main").getByText("我是桌面周报助手，有什么想让我帮忙的？", { exact: true }).waitFor();
    await other.close();
  });

  it("资料面板编辑保存长说明，重新打开后保留换行", async () => {
    await page.goto(`${base}/?mock=1&scene=s1`);
    await page.getByTitle("编辑助手").click();
    const input = page.getByLabel("补充提示词");
    const value = `第一行\n${"详细格式和工作方法。".repeat(400)}\n最后一行`;
    await input.fill(value);
    await input.blur();
    await page.getByText("已保存").first().waitFor();
    await page.getByTitle("返回").last().click();
    await page.getByTitle("编辑助手").click();
    expect(await page.getByLabel("补充提示词").inputValue()).toBe(value);
  }, 30000);

  it("草稿卡预览说明并用统一展开行展开全文", async () => {
    await page.goto(`${base}/?mock=1&scene=readme-cards`);
    const preview = page.locator(".draft-instructions");
    const disclosure = page.locator(".draft-instructions-disclosure > .disclosure-row");
    await preview.waitFor();
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    await disclosure.click();
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await preview.innerText()).toContain("遇到不确定的归属时列出问题。");
    await disclosure.click();
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
  }, 30000);
});
