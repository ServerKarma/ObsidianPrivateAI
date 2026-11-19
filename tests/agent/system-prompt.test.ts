// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, estimateTokens } from '../../src/agent/pi/systemPrompt';

const TODAY = new Date('2026-11-19T12:00:00Z');

describe('system prompt', () => {
	it('sends the default prompt with the date and no preferences block when there are none', () => {
		const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, '', TODAY);
		expect(prompt.startsWith('You are Private AI')).toBe(true);
		expect(prompt).toContain('search_notes');
		expect(prompt).toContain("Today's date is 2026-11-19.");
		expect(prompt).not.toContain("The user's preferences");
	});

	it('sends the user\'s own prompt instead of the default, with nothing hard-coded added', () => {
		const prompt = buildSystemPrompt('Answer in one sentence.', 'I like metric units.', TODAY);
		expect(prompt).toBe("Answer in one sentence.\n\nToday's date is 2026-11-19.\n\nThe user's preferences:\nI like metric units.");
	});

	it('sends only the date when the prompt is emptied', () => {
		expect(buildSystemPrompt('  ', '', TODAY)).toBe("Today's date is 2026-11-19.");
	});

	it('estimates tokens so settings can show what the prompt costs', () => {
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('a'.repeat(400))).toBe(100);
		expect(estimateTokens(DEFAULT_SYSTEM_PROMPT)).toBeGreaterThan(300);
	});
});
