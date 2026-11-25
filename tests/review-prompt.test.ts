import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian';
import {
	REVIEW_FIRST_ASK_AFTER_CHATS,
	REVIEW_FIRST_ASK_AFTER_USAGE_MS,
	REVIEW_REPEAT_AFTER_CHATS,
	REVIEW_REPEAT_AFTER_MS,
	ReviewPromptState,
	shouldShowReviewPrompt
} from '../src/services/reviewPrompt';
import { ReviewModal } from '../src/views/ReviewModal';

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;

function state(overrides: Partial<ReviewPromptState> = {}): ReviewPromptState {
	return {
		reviewLinkClicked: false,
		successfulChats: REVIEW_FIRST_ASK_AFTER_CHATS,
		usageTimeMs: REVIEW_FIRST_ASK_AFTER_USAGE_MS,
		lastReviewPromptTimestamp: null,
		successfulChatsAtLastReviewPrompt: 0,
		...overrides
	};
}

describe('shouldShowReviewPrompt', () => {
	it('waits for enough answered chats and usage time', () => {
		expect(shouldShowReviewPrompt(state({ successfulChats: REVIEW_FIRST_ASK_AFTER_CHATS - 1 }), now)).toBe(false);
		expect(shouldShowReviewPrompt(state({ usageTimeMs: REVIEW_FIRST_ASK_AFTER_USAGE_MS - 1 }), now)).toBe(false);
		expect(shouldShowReviewPrompt(state(), now)).toBe(true);
	});

	it('never asks again once the user acted', () => {
		expect(shouldShowReviewPrompt(state({ reviewLinkClicked: true, successfulChats: 500 }), now)).toBe(false);
	});

	it('comes back after a dismissal only when both the days and the chats have passed', () => {
		const dismissed = { lastReviewPromptTimestamp: now - REVIEW_REPEAT_AFTER_MS, successfulChatsAtLastReviewPrompt: 10 };
		expect(shouldShowReviewPrompt(state({ ...dismissed, successfulChats: 10 + REVIEW_REPEAT_AFTER_CHATS }), now)).toBe(true);
		expect(shouldShowReviewPrompt(state({ ...dismissed, successfulChats: 10 + REVIEW_REPEAT_AFTER_CHATS - 1 }), now)).toBe(false);
		expect(shouldShowReviewPrompt(state({ ...dismissed, successfulChats: 50 }), now)).toBe(true);
		expect(shouldShowReviewPrompt(state({ ...dismissed, successfulChats: 50, lastReviewPromptTimestamp: now - DAY }), now)).toBe(false);
	});
});

describe('ReviewModal', () => {
	function open() {
		const onChoice = vi.fn();
		const modal = new ReviewModal(new App() as any, 7, onChoice);
		modal.open();
		return { modal, onChoice };
	}

	function button(modal: ReviewModal, text: string): HTMLButtonElement {
		const found = Array.from(modal.contentEl.querySelectorAll('button')).find(b => b.textContent?.includes(text));
		if (!found) throw new Error(`No button ${text}`);
		return found as HTMLButtonElement;
	}

	it('shows the ask with the chat count', () => {
		const { modal } = open();
		expect(modal.contentEl.textContent).toContain('Enjoying Private AI?');
		expect(modal.contentEl.textContent).toContain('answered 7 of your questions');
	});

	it.each([
		['Leave a review', 'review'],
		['Star on GitHub', 'star'],
		['I already left a review', 'already'],
		['Maybe later', 'later']
	])('reports %s as %s', (label, choice) => {
		const { modal, onChoice } = open();
		button(modal, label).click();
		expect(onChoice).toHaveBeenCalledWith(choice);
	});

	it('treats closing it (Esc or X) as maybe later', () => {
		const { modal, onChoice } = open();
		modal.close();
		expect(onChoice).toHaveBeenCalledWith('later');
	});
});
