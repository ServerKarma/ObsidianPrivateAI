import { App, Modal } from 'obsidian';

export type ReviewModalChoice = 'review' | 'star' | 'already' | 'later';

/**
 * A static, local ask for a review. Nothing is loaded over the network; the buttons only open
 * the review page or the repository in the browser.
 */
export class ReviewModal extends Modal {
	private choice: ReviewModalChoice = 'later';

	constructor(
		app: App,
		private readonly successfulChats: number,
		private readonly onChoice: (choice: ReviewModalChoice) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('local-llm-review-modal');
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('div', { cls: 'local-llm-review-modal-stars', text: '★★★★★' });
		contentEl.createEl('h2', { cls: 'local-llm-review-modal-title', text: 'Enjoying Private AI?' });
		contentEl.createEl('p', {
			cls: 'local-llm-review-modal-body',
			text: `Private AI has answered ${this.successfulChats} of your questions, all on your own machine. ` +
				'It is built by one developer, and reviews are how other Obsidian users find it.'
		});
		contentEl.createEl('p', {
			cls: 'local-llm-review-modal-body',
			text: 'Would you take 30 seconds to leave a review?'
		});

		const actions = contentEl.createEl('div', { cls: 'local-llm-review-modal-actions' });
		const reviewButton = actions.createEl('button', {
			text: 'Leave a review',
			cls: 'mod-cta local-llm-review-modal-primary',
			attr: { type: 'button' }
		});
		reviewButton.addEventListener('click', () => this.choose('review'));

		const starButton = actions.createEl('button', {
			text: '⭐ Star on GitHub',
			attr: { type: 'button' }
		});
		starButton.addEventListener('click', () => this.choose('star'));

		const footer = contentEl.createEl('div', { cls: 'local-llm-review-modal-footer' });
		const laterButton = footer.createEl('button', {
			text: 'Maybe later',
			cls: 'local-llm-review-modal-link',
			attr: { type: 'button' }
		});
		laterButton.addEventListener('click', () => this.choose('later'));
		const alreadyButton = footer.createEl('button', {
			text: 'I already left a review',
			cls: 'local-llm-review-modal-link',
			attr: { type: 'button' }
		});
		alreadyButton.addEventListener('click', () => this.choose('already'));

		window.setTimeout(() => reviewButton.focus(), 0);
	}

	private choose(choice: ReviewModalChoice): void {
		this.choice = choice;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		// Closing with Esc, the X, or a click outside counts as "Maybe later".
		this.onChoice(this.choice);
	}
}
