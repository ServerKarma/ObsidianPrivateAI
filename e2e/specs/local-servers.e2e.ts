import * as net from "node:net";
import { browser, expect } from "@wdio/globals";
import { FakeOllama, startFakeOllama } from "../support/fakeOllama";
import { toolResults } from "../support/fakeLmStudio";
import { askAndWait, errorDialogText, newChatWelcome, waitForNotice } from "../support/chat";

const CHAT = '[data-type="local-llm-chat-view"]';

/** Points the plugin at a server of this type and opens the chat pane. */
async function useServerOfType(serverType: string, apiEndpoint: string): Promise<void> {
    await browser.executeObsidian(async ({ app }, type, endpoint) => {
        const plugin = (app as any).plugins.plugins["private-ai"];
        Object.assign(plugin.settings, { serverType: type, apiEndpoint: endpoint, model: undefined });
        await plugin.saveSettings();
    }, serverType, apiEndpoint);
    await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
    await browser.$(`${CHAT} textarea.local-llm-input`).waitForExist({ timeout: 10000 });
}

async function closedEndpoint(): Promise<string> {
    const port = await new Promise<number>((resolve) => {
        const probe = net.createServer();
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
    return `http://127.0.0.1:${port}/v1/chat/completions`;
}

describe("Private AI with Ollama and other local servers", function () {
    let ollama: FakeOllama | null = null;

    after(async function () {
        await ollama?.close();
        // Leave the plugin on LM Studio for the other specs.
        await browser.executeObsidian(async ({ app }) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            Object.assign(plugin.settings, { serverType: "lmstudio", apiEndpoint: "http://localhost:1234/v1/chat/completions", model: undefined });
            await plugin.saveSettings();
        });
    });

    it("switches the endpoint when Ollama is picked in settings", async function () {
        await browser.executeObsidian(async ({ app }) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            Object.assign(plugin.settings, { serverType: "lmstudio", apiEndpoint: "http://localhost:1234/v1/chat/completions" });
            await plugin.saveSettings();
        });
        const main = await browser.getWindowHandle();
        await browser.executeObsidian(({ app }) => {
            (app as any).setting.open();
            (app as any).setting.openTabById("private-ai");
        });
        try {
            let picked = false;
            await browser.waitUntil(async () => {
                for (const handle of await browser.getWindowHandles()) {
                    await browser.switchToWindow(handle);
                    picked = await browser.execute(() => {
                        const item = Array.from(document.querySelectorAll(".setting-item"))
                            .find((el) => el.querySelector(".setting-item-name")?.textContent?.trim() === "Local server");
                        const select = item?.querySelector("select") as HTMLSelectElement | null;
                        if (!select) return false;
                        select.value = "ollama";
                        select.dispatchEvent(new Event("change"));
                        return true;
                    });
                    if (picked) return true;
                }
                return false;
            }, { timeout: 10000, timeoutMsg: "the Local server setting was not found" });
            // The page redraws with Ollama's wording and endpoint.
            await browser.waitUntil(async () => browser.execute(() =>
                Array.from(document.querySelectorAll("input[type=text]")).some((i) => (i as HTMLInputElement).value === "http://localhost:11434/v1/chat/completions")),
                { timeout: 10000, timeoutMsg: "the endpoint field did not change to Ollama's" });
        } finally {
            if ((await browser.getWindowHandle()) !== main) await browser.execute(() => window.close());
            await browser.switchToWindow(main);
            await browser.executeObsidian(({ app }) => (app as any).setting.close());
        }
        const saved = await browser.executeObsidian(({ app }) => {
            const s = (app as any).plugins.plugins["private-ai"].settings;
            return { serverType: s.serverType, apiEndpoint: s.apiEndpoint };
        });
        expect(saved).toEqual({ serverType: "ollama", apiEndpoint: "http://localhost:11434/v1/chat/completions" });
    });

    it("says Ollama can't be reached when it isn't running", async function () {
        await useServerOfType("ollama", await closedEndpoint());
        const welcome = await newChatWelcome();
        expect(welcome).toContain("ollama.com");
        expect(welcome).not.toContain("LM Studio");
        const reply = await askAndWait("When did I replace the water heater?");
        expect(reply).toContain("Can't reach Ollama");
        expect(await errorDialogText()).toBe("");
    });

    it("answers from the vault through Ollama, picking a downloaded model that can use tools", async function () {
        ollama = await startFakeOllama([
            { name: "llama2:7b", size: 1_000, capabilities: ["completion"] },
            { name: "gemma4:e4b", size: 9_000, capabilities: ["completion", "tools", "vision"] },
            { name: "gemma4:e2b", size: 5_000, capabilities: ["completion", "tools", "vision"] },
            { name: "nomic-embed-text:latest", size: 100, capabilities: ["embedding"] },
        ], (body) => toolResults(body).length === 0
            ? { toolCalls: [{ name: "grep_notes", args: { pattern: "water heater" } }] }
            : { text: "You replaced it on 2024-03-15 (Home/Water Heater Replacement.md)." });
        await useServerOfType("ollama", ollama.url);
        expect(await newChatWelcome()).toBe("");

        const reply = await askAndWait("When did I replace the water heater?");
        expect(reply).toContain("2024-03-15");
        expect(ollama.requests.length).toBeGreaterThanOrEqual(2);
        // llama2 is smaller but can't use tools; the embedding model isn't a chat model.
        expect(ollama.requests[0].model).toBe("gemma4:e2b");
        expect(ollama.requests[0].tools.map((t: any) => t.function.name)).toContain("grep_notes");
        // Reply length and sampling are left to the model's settings in Ollama.
        expect(ollama.requests[0]).not.toHaveProperty("max_tokens");
        expect(ollama.requests[0]).not.toHaveProperty("temperature");
        expect(toolResults(ollama.requests[1]).join("\n")).toContain("Home/Water Heater Replacement.md");
    });

    it("uses the context Ollama loaded the model with, and warns when it is small", async function () {
        const userTexts = (body: any): string[] => body.messages.filter((m: any) => m.role === "user").map((m: any) => JSON.stringify(m.content));
        const long = `Background for later: ${"the boiler hums in the basement. ".repeat(400)}`; // about 13,000 characters
        const usersInLastRequest = () => userTexts(ollama!.requests[ollama!.requests.length - 1]);

        // 64k loaded: the long message stays in the history.
        ollama!.load("gemma4:e2b", 65536);
        // Typed in one go: setValue would send 13,000 key presses.
        await browser.execute((chat, text) => {
            const input = document.querySelector(`${chat} textarea.local-llm-input`) as HTMLTextAreaElement;
            input.value = text;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            (document.querySelector(`${chat} .local-llm-send-button`) as HTMLElement).click();
        }, CHAT, long);
        await browser.waitUntil(() => ollama!.requests.some((r) => userTexts(r).some((t) => t.includes("boiler hums"))), { timeout: 15000, timeoutMsg: "the long message was not sent" });
        await browser.waitUntil(async () => browser.execute((chat) => {
            const send = document.querySelector(`${chat} .local-llm-send-button`) as HTMLButtonElement | null;
            return !!send && !send.disabled && !document.querySelector(`${chat} .local-llm-stop-button-visible`);
        }, CHAT), { timeout: 30000, timeoutMsg: "the long message got no reply" });
        ollama!.requests.length = 0;
        await askAndWait("When did I replace the water heater?");
        expect(usersInLastRequest().some((t) => t.includes("boiler hums"))).toBe(true);

        // 4k loaded: the same history no longer fits, so the long message is dropped, and the user is told why.
        ollama!.load("gemma4:e2b", 4096);
        ollama!.requests.length = 0;
        await askAndWait("And what did it cost?");
        expect(usersInLastRequest().some((t) => t.includes("boiler hums"))).toBe(false);
        expect(await waitForNotice(/4,096-token context/)).toContain("Context length in the Ollama app");
    });
});
