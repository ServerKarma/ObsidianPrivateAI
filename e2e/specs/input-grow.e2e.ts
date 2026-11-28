import { browser, expect } from "@wdio/globals";

const INPUT = '[data-type="local-llm-chat-view"] textarea.local-llm-input';

/** Height of the message box, and whether its text is cut off (scrolls inside the box). */
async function measure(): Promise<{ height: number; clipped: boolean; max: number }> {
    return browser.execute((sel) => {
        const el = document.querySelector(sel) as HTMLTextAreaElement;
        return {
            height: el.getBoundingClientRect().height,
            clipped: el.scrollHeight > el.clientHeight + 1,
            max: parseFloat(getComputedStyle(el).maxHeight),
        };
    }, INPUT);
}

// Issue #80: a long prompt should grow the box to show it all, up to a max height.
describe("Chat message box grows with its text", function () {
    before(async function () {
        await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
        await browser.$(INPUT).waitForExist({ timeout: 10000 });
    });

    it("starts one line tall", async function () {
        const { height } = await measure();
        expect(height).toBeLessThan(60);
    });

    it("grows to show the whole of a multi-sentence prompt", async function () {
        const start = (await measure()).height;
        await browser.$(INPUT).setValue(
            "Summarize all the notes and extract the key themes I should reflect on? This is all the notes from the last 7 days. Notice any themes or patterns I should be aware of? Anything seem subtle that I might easily miss?"
        );
        const after = await measure();
        expect(after.height).toBeGreaterThan(start);
        expect(after.clipped).toBe(false);
    });

    it("stops at the max height and scrolls past it", async function () {
        // Typing Enter would send the message, so paste the long text in the way a paste does.
        await browser.execute((sel, text) => {
            const el = document.querySelector(sel) as HTMLTextAreaElement;
            el.value = text;
            el.dispatchEvent(new Event("input"));
        }, INPUT, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
        const { height, clipped, max } = await measure();
        expect(Math.round(height)).toBe(Math.round(max));
        expect(clipped).toBe(true);
    });

    it("shrinks back when the text is deleted", async function () {
        await browser.$(INPUT).clearValue();
        await browser.execute((sel) => document.querySelector(sel)!.dispatchEvent(new Event("input")), INPUT);
        expect((await measure()).height).toBeLessThan(60);
    });
});
