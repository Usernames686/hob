import { useState, type FormEvent } from "react";
import { assistantAbilities, assistantNameError } from "../../../shared/assistant-create.ts";
import { t } from "../../../shared/i18n.ts";
import { distinctPetSprite } from "../../../shared/pet.ts";
import { Avatar } from "../sprites.tsx";
import { createAssistant, newAssistant, useApp } from "../store.ts";
import { DialogShell } from "./DialogShell.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { PetPicker } from "./PetPicker.tsx";

export function NewAssistantDialog({ onClose }: { onClose: () => void }) {
  const { assistants } = useApp();
  const [sprite, setSprite] = useState(() => distinctPetSprite(undefined, assistants.map(a => a.sprite)));
  const [picking, setPicking] = useState(false);
  const [more, setMore] = useState(false);
  const [abilities, setAbilities] = useState(() => assistantAbilities(undefined));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const field = (key: string) => String(data.get(key) ?? "").trim();
    const name = field("name");
    const invalid = assistantNameError(name);
    if (invalid) { setError(invalid); return; }
    setError(null);
    setBusy(true);
    const failure = await createAssistant({
      name, sprite, duty: field("duty"), dutyLong: field("dutyLong"), instructions: field("instructions"), cwd: field("cwd"), abilities,
    });
    if (failure) { setError(failure); setBusy(false); }
    else onClose();
  };

  const switches = [
    ["exec", t("执行命令")], ["write", t("修改文件")], ["image", t("图像生成")],
  ] as const;

  return <DialogShell label={t("新建助手")} title={t("新建助手")} className="assistant-create" onSubmit={submit} onClose={onClose} dismissible={!busy}
    actions={<>
      <button type="button" className="hob-btn assistant-create-chat" disabled={busy} onClick={() => { onClose(); newAssistant(); }}>{t("找 Hob 聊着建")}</button>
      <button type="button" className="hob-btn" disabled={busy} onClick={onClose}>{t("取消")}</button>
      <button type="submit" className="hob-btn hob-btn-primary" disabled={busy}>{busy ? t("正在创建…") : t("创建")}</button>
    </>}>
    <div className="assistant-create-body">
      <div className="assistant-create-pet">
        <Avatar sprite={sprite} size={76} free live interactive follow morphBounce />
        <PetPicker sprite={sprite} onChange={setSprite} expanded={picking} toggle={
          <button type="button" className="hob-btn" aria-expanded={picking} onClick={() => setPicking(!picking)}>{picking ? t("收起") : t("换造型")}</button>
        } />
      </div>
      <label className="gcreate-field"><span>{t("名字")}</span>
        <input name="name" required autoFocus autoComplete="off" placeholder={t("例如「前端搭子」「周报助手」")} />
      </label>
      <label className="gcreate-field"><span>{t("简短职责（最多 8 字）")}</span>
        <input name="duty" autoComplete="off" placeholder={t("例如「写代码查 Bug」")} />
      </label>
      <label className="gcreate-field"><span>{t("详细职责")}</span>
        <textarea name="dutyLong" rows={2} placeholder={t("这个助手负责哪些事？")} />
      </label>
      <label className="gcreate-field"><span>{t("补充提示词")}</span>
        <textarea name="instructions" rows={2} placeholder={t("性格、说话风格或工作规范")} />
      </label>
      <Disclosure label={t("更多选项")} open={more} onToggle={() => setMore(!more)}>
        <div className="assistant-create-options">
          <label className="gcreate-field"><span>{t("工作目录（可选）")}</span>
            <input name="cwd" spellCheck={false} placeholder={t("如 /workspace/app，创建后不可修改")} />
          </label>
          <fieldset className="assistant-create-abilities">
            <legend>{t("初始能力")}</legend>
            {switches.map(([key, label]) => <label key={key}>
              <span>{label}</span>
              <input type="checkbox" role="switch" className={abilities[key] ? "tog" : "tog off"} checked={abilities[key]} onChange={e => setAbilities({ ...abilities, [key]: e.target.checked })} />
            </label>)}
          </fieldset>
        </div>
      </Disclosure>
    </div>
    {error && <div className="gcreate-error" role="alert">{error}</div>}
  </DialogShell>;
}
