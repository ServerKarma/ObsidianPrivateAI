/**
 * When to ask for a review. Kept free of Obsidian imports so it can be unit tested.
 *
 * The ask comes only after the user has had a good run with the plugin (several answered
 * chats, not just installed it), right after an answer finishes. Dismissing it only snoozes it:
 * it comes back after both some days and some more answered chats. Leaving a review, starring
 * the repository, or saying "I already did" ends it for good.
 */

/** Answered chats before the first ask. */
export const REVIEW_FIRST_ASK_AFTER_CHATS = 5;
/** Time with the plugin loaded before the first ask (also guards against a burst of chats on day one). */
export const REVIEW_FIRST_ASK_AFTER_USAGE_MS = 60 * 60 * 1000;
/** After a dismissal, wait at least this long ... */
export const REVIEW_REPEAT_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** ... and at least this many more answered chats. */
export const REVIEW_REPEAT_AFTER_CHATS = 3;
/** Wait after an answer finishes so the user sees it before the modal opens. */
export const REVIEW_MODAL_DELAY_MS = 1500;

export const REVIEW_PAGE_URL = 'https://www.obsidianstats.com/plugins/private-ai';
export const GITHUB_REPO_URL = 'https://github.com/ServerKarma/ObsidianPrivateAI';

export interface ReviewPromptState {
	/** True once the user reviewed, starred, or said they already did. Never ask again. */
	reviewLinkClicked: boolean;
	successfulChats: number;
	usageTimeMs: number;
	lastReviewPromptTimestamp: number | null;
	successfulChatsAtLastReviewPrompt: number;
}

export function shouldShowReviewPrompt(state: ReviewPromptState, now: number): boolean {
	if (state.reviewLinkClicked) return false;
	if (state.successfulChats < REVIEW_FIRST_ASK_AFTER_CHATS) return false;
	if (state.usageTimeMs < REVIEW_FIRST_ASK_AFTER_USAGE_MS) return false;
	if (state.lastReviewPromptTimestamp === null) return true;
	return now - state.lastReviewPromptTimestamp >= REVIEW_REPEAT_AFTER_MS
		&& state.successfulChats - state.successfulChatsAtLastReviewPrompt >= REVIEW_REPEAT_AFTER_CHATS;
}
