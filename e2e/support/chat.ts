import { browser } from "@wdio/globals";

const CHAT = '[data-type="local-llm-chat-view"]';

/** Points the plugin at a server and opens the chat pane. An empty model means Auto. */
export async function useServer(apiEndpoint: string, model = ""): Promise<void> {
    await browser.executeObsidian(async ({ app }, endpoint, modelId) => {
        const plugin = (app as any).plugins.plugins["private-ai"];
        Object.assign(plugin.settings, { apiEndpoint: endpoint, model: modelId });
        await plugin.saveSettings();
    }, apiEndpoint, model);
    await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
    await browser.$(`${CHAT} textarea.local-llm-input`).waitForExist({ timeout: 10000 });
    await serverChecked();
}

/** Waits until the chat pane has finished checking the server (it does that in the background). */
export async function serverChecked(): Promise<void> {
    await browser.executeObsidian(async ({ app }) => {
        for (const leaf of app.workspace.getLeavesOfType("local-llm-chat-view")) await (leaf.view as any).welcomeReady;
    });
}

/** The hint shown in the empty message box. */
export async function inputPlaceholder(): Promise<string> {
    return (await browser.$(`${CHAT} textarea.local-llm-input`).getAttribute("placeholder")) ?? "";
}

export async function ask(question: string): Promise<void> {
    await browser.$(`${CHAT} textarea.local-llm-input`).setValue(question);
    await browser.execute((chat) => (document.querySelector(`${chat} .local-llm-send-button`) as HTMLElement).click(), CHAT);
}

export async function lastAssistantText(): Promise<string> {
    return browser.execute((chat) => {
        const all = document.querySelectorAll(`${chat} .local-llm-message-assistant .local-llm-message-content`);
        return (all[all.length - 1]?.textContent ?? "").trim();
    }, CHAT);
}

/**
 * Starts a new chat and returns the instructions it opens with, or "" when the chat
 * starts empty (which it does when the server is ready to use).
 */
export async function newChatWelcome(): Promise<string> {
    // Clicked from inside the page: a notice from an earlier step may be covering the button.
    await browser.execute((chat) => (document.querySelector(`${chat} .local-llm-new-chat-button`) as HTMLElement).click(), CHAT);
    await serverChecked();
    return browser.execute((chat) => {
        const messages = document.querySelectorAll(`${chat} .local-llm-message`);
        if (messages.length > 1) throw new Error(`a new chat should start with at most one message, found ${messages.length}`);
        return (messages[0]?.querySelector(".local-llm-message-content")?.textContent ?? "").trim();
    }, CHAT);
}

/** Sends a question and waits until the turn is over (the Send button is back), then returns the reply. */
export async function askAndWait(question: string, timeout = 30000): Promise<string> {
    await ask(question);
    await browser.waitUntil(async () => browser.execute((chat) => {
        const send = document.querySelector(`${chat} .local-llm-send-button`) as HTMLButtonElement | null;
        const streaming = document.querySelector(`${chat} .local-llm-stop-button-visible`);
        return !!send && !send.disabled && !streaming;
    }, CHAT), { timeout, timeoutMsg: `no reply to "${question}" within ${timeout / 1000}s` });
    return lastAssistantText();
}

/** Text of every notice (toast) on screen. */
export async function noticeTexts(): Promise<string[]> {
    return browser.execute(() => Array.from(document.querySelectorAll(".notice")).map((n) => (n.textContent ?? "").trim()));
}

export async function waitForNotice(pattern: RegExp, timeout = 30000): Promise<string> {
    let found = "";
    await browser.waitUntil(async () => {
        found = (await noticeTexts()).find((t) => pattern.test(t)) ?? "";
        return found.length > 0;
    }, { timeout, timeoutMsg: `no notice matching ${pattern}; on screen: ${JSON.stringify(await noticeTexts())}` });
    return found;
}

/** Puts a small PNG in the vault and runs "Read text from images now" the way the settings button does. */
export async function processOneImage(path: string): Promise<void> {
    await browser.executeObsidian(async ({ app }, imagePath) => {
        // A 1x1 PNG: enough to be an image the plugin wants to read.
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const existing = app.vault.getFileByPath(imagePath);
        if (existing) await app.vault.delete(existing);
        const folder = imagePath.split("/").slice(0, -1).join("/");
        if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
        await app.vault.createBinary(imagePath, bytes.buffer);
        const plugin = (app as any).plugins.plugins["private-ai"];
        plugin.settings.enableImageTextExtraction = true;
        void plugin.processImages(false);
    }, path);
}

/** True when Obsidian is showing its "An error occurred while loading" dialog or any error modal. */
export async function errorDialogText(): Promise<string> {
    return browser.execute(() => Array.from(document.querySelectorAll(".modal"))
        .map((m) => (m.textContent ?? "").trim())
        .filter((t) => /error occurred|TypeError|is not a function/i.test(t))
        .join(" | "));
}
