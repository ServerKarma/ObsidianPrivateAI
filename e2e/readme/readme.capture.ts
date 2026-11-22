import { browser } from "@wdio/globals";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FakeLmStudio, lastUserText, startFakeLmStudio, toolResults } from "../support/fakeLmStudio";

/**
 * Captures the README screenshots and demo GIF. Everything on screen is the real
 * plugin in real Obsidian with the demo notes in e2e/vault. Only the model's
 * words are scripted, so the capture needs no LM Studio and comes out the same
 * every time. Writes to img/readme/.
 *
 * The GIF is recorded with ffmpeg from the X display, so run it under Xvfb with
 * a screen the size of the window:
 *   xvfb-run -a -s "-screen 0 1280x800x24" npm run screenshots
 */
const WIDTH = 1280;
const HEIGHT = 800;
const OUT = path.resolve(__dirname, "..", "..", "img", "readme");
const CHAT = '[data-type="local-llm-chat-view"]';

const GARDEN_CHECKLIST = [
    "# Spring Garden",
    "",
    "- [ ] Start peppers indoors in March",
    "- [ ] Rotate the raised beds",
    "- [ ] Plant tomatoes after the last frost (around May 15)",
    "- [ ] Order straw mulch for the October garlic",
    "",
].join("\n");

function reply(body: any) {
    const question = lastUserText(body).split("User question: ").pop() ?? "";
    const results = toolResults(body);
    if (/water heater/i.test(question)) {
        if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "water heater replaced cost" } }] };
        if (results.length === 1) return { toolCalls: [{ name: "read_note", args: { path: "Home/Water Heater Replacement.md" } }] };
        return {
            text: "You replaced the water heater on **2024-03-15**. It's a Rheem Performance Platinum 50 gallon, and it cost **$1,850** installed by Mike's Plumbing. The old one was 14 years old and leaking from the tank seam.",
        };
    }
    if (/spring garden/i.test(question)) {
        if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "garden planting calendar" } }] };
        if (results.length === 1) return { toolCalls: [{ name: "read_note", args: { path: "Home/Garden Planting Calendar.md" } }] };
        if (results.length === 2) return { toolCalls: [{ name: "create_note", args: { path: "Projects/Spring Garden.md", content: GARDEN_CHECKLIST } }] };
        return { text: "Done. I created **Projects/Spring Garden.md** with a checklist from your planting calendar." };
    }
    return { text: "Hello!" };
}

async function type(text: string): Promise<void> {
    const input = browser.$(`${CHAT} textarea.local-llm-input`);
    await input.click();
    for (let i = 0; i < text.length; i += 3) {
        await input.addValue(text.slice(i, i + 3));
    }
    await browser.pause(400);
    await browser.$(`${CHAT} .local-llm-send-button`).click();
}

async function turnOver(): Promise<void> {
    await browser.waitUntil(async () => browser.execute((chat) => {
        const send = document.querySelector(`${chat} .local-llm-send-button`) as HTMLButtonElement | null;
        return !!send && !send.disabled && !document.querySelector(`${chat} .local-llm-stop-button-visible`);
    }, CHAT), { timeout: 60000 });
}

async function shot(name: string): Promise<void> {
    await browser.pause(500);
    await browser.saveScreenshot(path.join(OUT, `${name}.png`));
}

describe("README capture", function () {
    let llm: FakeLmStudio;
    let recorder: ChildProcess | undefined;
    const video = path.join(OUT, "demo.mp4");

    before(async function () {
        fs.mkdirSync(OUT, { recursive: true });
        llm = await startFakeLmStudio(reply, { delayMs: 90 });
        // WebDriver can't resize an Electron window, so ask Electron directly.
        await browser.execute((w, h) => {
            const req = (window as any).require;
            const remote = (() => { try { return req("@electron/remote"); } catch { return req("electron").remote; } })();
            const win = remote.getCurrentWindow();
            win.unmaximize();
            win.setBounds({ x: 0, y: 0, width: w, height: h });
        }, WIDTH, HEIGHT);
        await browser.pause(1000);
        await browser.executeObsidian(async ({ app }, url) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            Object.assign(plugin.settings, { apiEndpoint: url, model: "mock-model", allowNoteChanges: true, contextNotesVisible: true });
            await plugin.saveSettings();
            (app as any).changeTheme?.("obsidian");
            (app.vault as any).setConfig?.("showInlineTitle", false);
            app.workspace.leftSplit.expand();
            await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Journal/2024-11-02 Hiking Mount Monadnock.md") as any);
        }, llm.url);
        await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
        await browser.$(`${CHAT} textarea.local-llm-input`).waitForClickable({ timeout: 20000 });
        // Give the chat room to breathe; the file list only needs to show the demo folders.
        // Obsidian settles its layout a moment after the window resize and can undo a
        // sidebar resize made too early, so keep setting it until it sticks.
        await browser.waitUntil(async () => {
            await browser.executeObsidian(({ app }) => {
                (app.workspace.leftSplit as any).setSize(220);
                (app.workspace.rightSplit as any).setSize(460);
            });
            await browser.pause(700);
            return browser.execute(() => document.querySelector(".mod-right-split")!.getBoundingClientRect().width === 460);
        }, { timeout: 15000, timeoutMsg: "the chat sidebar would not resize" });
        await browser.pause(800);

        if (process.env.DISPLAY && spawnSync("ffmpeg", ["-version"]).status === 0) {
            recorder = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-framerate", "12",
                "-video_size", `${WIDTH}x${HEIGHT}`, "-i", process.env.DISPLAY, "-pix_fmt", "yuv420p", video],
            { stdio: ["pipe", "inherit", "inherit"] });
            await browser.pause(800);
        }
    });

    after(async function () {
        if (recorder) {
            recorder.stdin?.write("q");
            await new Promise((resolve) => recorder!.on("exit", resolve));
            // Two-pass palette keeps Obsidian's dark theme clean in 256 colours.
            const filters = "fps=10,scale=960:-1:flags=lanczos";
            spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-vf",
                `${filters},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
                path.join(OUT, "demo.gif")], { stdio: "inherit" });
            fs.rmSync(video, { force: true });
        }
        await llm?.close();
    });

    it("answers a question from the notes", async function () {
        await type("When did I replace the water heater, and what did it cost?");
        await turnOver();
        await browser.pause(1500);
        await shot("chat");
    });

    it("asks before creating a note", async function () {
        await type("Make a Spring Garden note with a checklist from my planting calendar");
        const dialog = browser.$('[data-testid="confirm-change"]');
        await dialog.waitForExist({ timeout: 30000 });
        await browser.pause(1500);
        await shot("confirm");
        await browser.pause(1000);
        await browser.$('[data-testid="confirm-change-allow"]').click();
        await turnOver();
        await browser.executeObsidian(async ({ app }) => {
            await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Projects/Spring Garden.md") as any);
        });
        await browser.pause(1000);
        await shot("created");
        await browser.pause(2500);
    });
});
