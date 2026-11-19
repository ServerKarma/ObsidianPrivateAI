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

/** Asks once whether the read-only agent may start changing notes. Anything but "Yes" keeps it read-only. */
class EnableChangesModal extends Modal {
	private decided = false;

	constructor(app: App, private readonly source: string, private readonly wants: string, private readonly resolve: (ok: boolean) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('local-llm-confirm-change');
		contentEl.setAttr('data-testid', 'enable-changes');
		this.setTitle(`Let ${this.source} change your notes?`);
		contentEl.createEl('p', { text: `${this.source} is read-only right now: it can search and read your notes, but not change them. It is trying to use "${this.wants}".` });
		contentEl.createEl('p', { text: 'Do you want to turn on editing, deleting and moving notes? You will still be asked to approve every change, and you can turn this off again in the settings.' });

		new Setting(contentEl)
			.addButton((b) => b
				.setButtonText('No, keep it read-only')
				.then((btn) => btn.buttonEl.setAttr('data-testid', 'enable-changes-no'))
				.onClick(() => this.finish(false)))
			.addButton((b) => b
				.setButtonText('Yes, turn it on')
				.setCta()
				.then((btn) => btn.buttonEl.setAttr('data-testid', 'enable-changes-yes'))
				.onClick(() => this.finish(true)));
	}

	private finish(ok: boolean): void {
		if (this.decided) return;
		this.decided = true;
		this.resolve(ok);
		this.close();
	}

	onClose(): void {
		// Esc or clicking outside counts as No.
		this.finish(false);
		this.contentEl.empty();
	}
}

/** Shows the "turn on note changes?" question. `wants` names what the agent tried to do. */
export function askToEnableChanges(app: App, source: string, wants: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => new EnableChangesModal(app, source, wants, resolve).open());
}

/**
 * Confirmation for every write tool. Requests are shown one at a time, so
 * concurrent tool calls never stack dialogs.
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
