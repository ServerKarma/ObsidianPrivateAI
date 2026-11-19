import { App, Modal, Setting } from 'obsidian';
import { ChangeRequest, ConfirmChange } from '../tools/vaultTools';

const PREVIEW_LIMIT = 4000;

function clip(text: string): string {
	return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n… (${text.length - PREVIEW_LIMIT} more characters)` : text;
}

/** Shows one proposed vault change and resolves true only when the user clicks Allow. */
class ConfirmChangeModal extends Modal {
	private decided = false;

	constructor(app: App, private readonly request: ChangeRequest, private readonly source: string, private readonly resolve: (ok: boolean) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, request } = this;
		contentEl.addClass('local-llm-confirm-change');
		contentEl.setAttr('data-testid', 'confirm-change');
		this.setTitle(`${this.source} wants to change your vault`);
		contentEl.createEl('p', { cls: 'local-llm-confirm-change-title', text: request.title });

		// Text is set with createEl/text, never innerHTML, so note content can't inject markup.
		const preview = (label: string, text: string) => {
			contentEl.createEl('div', { cls: 'local-llm-confirm-change-label', text: label });
			contentEl.createEl('pre', { cls: 'local-llm-confirm-change-preview', text: clip(text) });
		};
		if (request.action === 'create') preview('Content', request.content ?? '');
		if (request.action === 'append') preview('Text to add at the end', request.content ?? '');
		if (request.action === 'edit') {
			preview('Replace this', request.before ?? '');
			preview('With this', request.after ?? '');
		}
		if (request.action === 'delete') contentEl.createEl('p', { text: 'The note goes to the trash, so it can be restored.' });

		new Setting(contentEl)
			.addButton((b) => b
				.setButtonText('Deny')
				.then((btn) => btn.buttonEl.setAttr('data-testid', 'confirm-change-deny'))
				.onClick(() => this.finish(false)))
			.addButton((b) => b
				.setButtonText('Allow')
				.setCta()
				.then((btn) => btn.buttonEl.setAttr('data-testid', 'confirm-change-allow'))
				.onClick(() => this.finish(true)));
	}

	private finish(ok: boolean): void {
		if (this.decided) return;
		this.decided = true;
		this.resolve(ok);
		this.close();
	}

	onClose(): void {
		// Closing the dialog any other way (Esc, clicking outside) counts as Deny.
		this.finish(false);
		this.contentEl.empty();
	}
}

/**
 * Confirmation for every write tool. Requests are shown one at a time, so
 * concurrent callers (for example an outside MCP client) never stack dialogs.
 * A request nobody answers within the timeout is denied.
 */
export function createModalConfirm(app: App, source: () => string, timeoutMs = 5 * 60 * 1000): ConfirmChange {
	let queue: Promise<unknown> = Promise.resolve();
	return (request) => {
		const run = () => new Promise<boolean>((resolve) => {
			let settled = false;
			const done = (ok: boolean) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				resolve(ok);
			};
			const modal = new ConfirmChangeModal(app, request, source(), done);
			const timer = window.setTimeout(() => {
				done(false);
				modal.close();
			}, timeoutMs);
			modal.open();
		});
		const next = queue.then(run, run);
		queue = next.catch(() => undefined);
		return next;
	};
}
