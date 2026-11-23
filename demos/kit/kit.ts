import { browser } from "@wdio/globals";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Helpers for demo recordings: size the window, record the X display with ffmpeg,
 * show a caption and a visible pointer, and click and type through the real UI.
 * The caption and pointer are overlays added for the viewer; every click and key
 * press goes to the real plugin.
 */
export const CHAT = '[data-type="local-llm-chat-view"]';
const WIDTH = 1280;
const HEIGHT = 800;
let recorder: ChildProcess | undefined;
let mp4 = "";

export async function setupWindow(): Promise<void> {
    await browser.execute((w, h) => {
        const req = (window as any).require;
        const remote = (() => { try { return req("@electron/remote"); } catch { return req("electron").remote; } })();
        const win = remote.getCurrentWindow();
        win.unmaximize();
        win.setBounds({ x: 0, y: 0, width: w, height: h });
    }, WIDTH, HEIGHT);
    await browser.pause(1000);
    await browser.executeObsidian(({ app }) => {
        (app as any).changeTheme?.("obsidian");
        (app.vault as any).setConfig?.("showInlineTitle", false);
        app.workspace.leftSplit.expand();
    });
}

export async function openChat(): Promise<void> {
    await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
    await browser.$(`${CHAT} textarea.local-llm-input`).waitForClickable({ timeout: 20000 });
    await browser.waitUntil(async () => {
        await browser.executeObsidian(({ app }) => {
            (app.workspace.leftSplit as any).setSize(220);
            (app.workspace.rightSplit as any).setSize(460);
        });
        await browser.pause(700);
        return browser.execute(() => document.querySelector(".mod-right-split")!.getBoundingClientRect().width === 460);
    }, { timeout: 15000, timeoutMsg: "the chat sidebar would not resize" });
    await serverChecked();
}

export async function serverChecked(): Promise<void> {
    await browser.executeObsidian(async ({ app }) => {
        for (const leaf of app.workspace.getLeavesOfType("local-llm-chat-view")) await (leaf.view as any).welcomeReady;
    });
}

export async function setSettings(values: Record<string, unknown>): Promise<void> {
    await browser.executeObsidian(async ({ app }, v) => {
        const plugin = (app as any).plugins.plugins["private-ai"];
        Object.assign(plugin.settings, v);
        await plugin.saveSettings();
    }, values);
}

export async function startRecording(outDir: string, name: string): Promise<void> {
    fs.mkdirSync(outDir, { recursive: true });
    mp4 = path.join(outDir, `${name}.mp4`);
    if (!process.env.DISPLAY || spawnSync("ffmpeg", ["-version"]).status !== 0) throw new Error("needs Xvfb and ffmpeg");
    recorder = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-framerate", "12",
        "-video_size", `${WIDTH}x${HEIGHT}`, "-draw_mouse", "0", "-i", process.env.DISPLAY, "-pix_fmt", "yuv420p", mp4],
    { stdio: ["pipe", "inherit", "inherit"] });
    await browser.pause(800);
}

/** Stops recording; keeps the MP4 and writes a GIF next to it. */
export async function stopRecording(): Promise<void> {
    if (!recorder) return;
    await browser.pause(1200);
    recorder.stdin?.write("q");
    await new Promise((resolve) => recorder!.on("exit", resolve));
    recorder = undefined;
    const filters = "fps=10,scale=960:-1:flags=lanczos";
    spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf",
        `${filters},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        mp4.replace(/\.mp4$/, ".gif")], { stdio: "inherit" });
}

/** A caption bar along the bottom of the window, saying what the viewer is about to see. */
let lastCaption = "";
export async function caption(text: string, hold = 1800): Promise<void> {
    lastCaption = text;
    await browser.execute((t) => {
        let el = document.getElementById("demo-caption");
        if (!el) {
            el = document.createElement("div");
            el.id = "demo-caption";
            el.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;"
                + "background:rgba(124,58,237,.95);color:#fff;font:600 17px/1.35 system-ui,sans-serif;padding:9px 18px;border-radius:10px;"
                + "box-shadow:0 6px 24px rgba(0,0,0,.45);white-space:nowrap;text-align:center;";
            document.body.appendChild(el);
        }
        el.textContent = t;
        el.style.display = "";
    }, text);
    await browser.pause(hold);
}

async function ensurePointer(): Promise<void> {
    await browser.execute(() => {
        if (document.getElementById("demo-pointer")) return;
        const p = document.createElement("div");
        p.id = "demo-pointer";
        p.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        p.style.cssText = "position:fixed;left:640px;top:400px;z-index:2147483647;pointer-events:none;transition:left .7s ease,top .7s ease;";
        const ring = document.createElement("div");
        ring.id = "demo-ring";
        ring.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;border-radius:50%;border:3px solid #a78bfa;opacity:0;transform:translate(-50%,-50%) scale(.4);transition:opacity .35s,transform .35s;";
        document.body.append(p, ring);
    });
}

/** Moves the visible pointer to the middle of an element. */
export async function pointAt(el: WebdriverIO.Element | ChainablePromiseElement): Promise<void> {
    await ensurePointer();
    const target = await el;
    await target.scrollIntoView({ block: "center" });
    await browser.execute((node: any) => {
        const r = node.getBoundingClientRect();
        const p = document.getElementById("demo-pointer")!;
        p.style.left = `${r.left + Math.min(r.width / 2, 60)}px`;
        p.style.top = `${r.top + r.height / 2}px`;
    }, target as any);
    await browser.pause(850);
}

async function ripple(): Promise<void> {
    await browser.execute(() => {
        const p = document.getElementById("demo-pointer")!;
        const ring = document.getElementById("demo-ring")!;
        ring.style.left = p.style.left;
        ring.style.top = p.style.top;
        ring.style.transition = "none";
        ring.style.opacity = "1";
        ring.style.transform = "translate(-50%,-50%) scale(.4)";
        void ring.offsetWidth;
        ring.style.transition = "opacity .5s, transform .5s";
        ring.style.opacity = "0";
        ring.style.transform = "translate(-50%,-50%) scale(1.4)";
    });
}

type ChainablePromiseElement = ReturnType<typeof browser.$>;

/** Points at an element, then clicks it for real. */
export async function click(el: WebdriverIO.Element | ChainablePromiseElement, pauseAfter = 700): Promise<void> {
    await pointAt(el);
    await ripple();
    await (await el).click();
    await browser.pause(pauseAfter);
}

/** Types into a field a few characters at a time, so it reads like typing. */
export async function typeInto(el: WebdriverIO.Element | ChainablePromiseElement, text: string): Promise<void> {
    await click(el, 200);
    const field = await el;
    for (let i = 0; i < text.length; i += 3) await field.addValue(text.slice(i, i + 3));
    await browser.pause(400);
}

export const chatInput = () => browser.$(`${CHAT} textarea.local-llm-input`);
export const sendButton = () => browser.$(`${CHAT} .local-llm-send-button`);

/** Types a question in the chat box, clicks Send, and waits for the turn to end. */
export async function ask(text: string, wait = true): Promise<void> {
    await typeInto(chatInput(), text);
    await click(sendButton(), 200);
    if (wait) await turnOver();
}

export async function turnOver(timeout = 60000): Promise<void> {
    await browser.waitUntil(async () => browser.execute((chat) => {
        const send = document.querySelector(`${chat} .local-llm-send-button`) as HTMLButtonElement | null;
        return !!send && !send.disabled && !document.querySelector(`${chat} .local-llm-stop-button-visible`);
    }, CHAT), { timeout });
    await browser.pause(1200);
}

export async function lastAnswer(): Promise<string> {
    return browser.execute((chat) => {
        const all = document.querySelectorAll(`${chat} .local-llm-message-assistant .local-llm-message-content`);
        return (all[all.length - 1]?.textContent ?? "").trim();
    }, CHAT);
}

let mainWindow = "";

/**
 * Opens Obsidian's settings with a real click on the gear, then the plugin's tab.
 * Obsidian 1.15 opens settings in its own window, so the demo follows it there.
 */
export async function openPluginSettings(): Promise<void> {
    mainWindow = await browser.getWindowHandle();
    const before = await browser.getWindowHandles();
    const gear = browser.$('.workspace-drawer-vault-actions .clickable-icon[aria-label="Settings"], [aria-label="Open settings"], .vault-profile .clickable-icon[aria-label="Settings"]');
    if (await gear.isExisting() && await gear.isDisplayed()) await click(gear, 300);
    else await browser.executeObsidian(({ app }) => (app as any).setting.open());
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length
        || await browser.execute(() => !!document.querySelector(".modal.mod-settings")), { timeout: 10000 });
    const added = (await browser.getWindowHandles()).find((h) => !before.includes(h));
    if (added) {
        // Only one caption on screen: the settings window shows it from here on.
        await browser.execute(() => { const c = document.getElementById("demo-caption"); if (c) c.style.display = "none"; });
        await browser.switchToWindow(added);
        await browser.pause(800);
        await caption(lastCaption, 0);
    }
    const tab = browser.$("(//div[contains(@class,'vertical-tab-nav-item')][normalize-space()='Private AI'])[1]");
    await tab.waitForExist({ timeout: 10000 });
    await click(tab, 1000);
}

export async function closeSettings(): Promise<void> {
    const handle = await browser.getWindowHandle();
    if (mainWindow && handle !== mainWindow) {
        const close = browser.$(".titlebar-button.mod-close, .modal-close-button");
        if (await close.isExisting() && await close.isDisplayed()) { await pointAt(close); await ripple(); await browser.pause(300); }
        await browser.execute(() => window.close());
        await browser.switchToWindow(mainWindow);
        await caption(lastCaption, 0);
    } else {
        await click(browser.$(".modal.mod-settings .modal-close-button"), 0);
    }
    await browser.pause(800);
}

/** The control (select, input, button) of the visible setting row with this name. */
export async function settingControl(name: string, control = "select"): Promise<WebdriverIO.Element> {
    let found: any = null;
    await browser.waitUntil(async () => {
        found = await browser.execute((n, c) => {
            const rows = Array.from(document.querySelectorAll(".setting-item")) as HTMLElement[];
            const row = rows.find((r) => r.offsetParent !== null && r.querySelector(".setting-item-name")?.textContent?.trim() === n);
            return (row?.querySelector(`.setting-item-control ${c}`) as any) ?? null;
        }, name, control);
        return !!found;
    }, { timeout: 10000, timeoutMsg: `no setting "${name}" with a ${control}` });
    return browser.$(found);
}

/** Points at a setting's dropdown and picks an option by its label. */
export async function pick(settingName: string, label: string): Promise<void> {
    const select = await settingControl(settingName);
    await pointAt(select);
    await ripple();
    // A native dropdown menu doesn't show in the recording, so the pick is made directly.
    await (await select).selectByVisibleText(label);
    await browser.pause(1200);
}

/** Scrolls the newest answer's thought process from the top to the bottom, slowly, so every step can be read. */
export async function readThinking(ms = 4000): Promise<void> {
    await browser.execute(async (chat, total) => {
        const msgs = document.querySelectorAll(`${chat} .local-llm-message-assistant`);
        const last = msgs[msgs.length - 1];
        if (!last) return;
        const box = Array.from(last.querySelectorAll("*")).find((el) => el.scrollHeight > el.clientHeight + 4
            && getComputedStyle(el).overflowY !== "visible") as HTMLElement | undefined;
        if (!box) return;
        box.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 900));
        const steps = 30;
        for (let i = 1; i <= steps; i++) {
            box.scrollTop = (box.scrollHeight - box.clientHeight) * i / steps;
            await new Promise((r) => setTimeout(r, (total - 900) / steps));
        }
    }, CHAT, ms);
    await browser.pause(800);
}
