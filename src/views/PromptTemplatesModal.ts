import { App, Modal, setIcon } from 'obsidian';
import { PromptTemplate, previewPrompt, templateName } from './promptTemplates';

/**
 * A window for managing the "/" prompt templates, opened from settings (Manage templates),
 * from the command palette, or from the "/" menu. A list of templates on the left and an
 * editor for the selected one on the right. Every change is saved as you type.
 */
export class PromptTemplatesModal extends Modal {
	private selected = 0;
	private listEl!: HTMLElement;
	private editorEl!: HTMLElement;

	constructor(
		app: App,
		/** The live list; edited in place. */
		private readonly templates: PromptTemplate[],
		private readonly save: () => Promise<void>,
		private readonly onClosed?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('local-llm-templates-modal');
		this.titleEl.setText('Prompt templates');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			cls: 'local-llm-templates-intro',
			text: 'Type / in the chat box to pick one of these. Its text goes in the message box, where you can edit it before sending.',
		});
		const body = contentEl.createEl('div', { cls: 'local-llm-templates-body' });
		const side = body.createEl('div', { cls: 'local-llm-templates-side' });
		this.listEl = side.createEl('div', { cls: 'local-llm-templates-list', attr: { role: 'listbox', 'aria-label': 'Templates' } });
		const addButton = side.createEl('button', { cls: 'local-llm-templates-add', text: 'New template' });
		addButton.addEventListener('click', () => void this.add());
		this.editorEl = body.createEl('div', { cls: 'local-llm-templates-editor' });
		this.render();
	}

	onClose(): void {
		// Drop templates left completely empty, so an unused "New template" leaves nothing behind.
		const before = this.templates.length;
		for (let i = this.templates.length - 1; i >= 0; i--) {
			if (!this.templates[i].name.trim() && !this.templates[i].prompt.trim()) this.templates.splice(i, 1);
		}
		if (this.templates.length !== before) void this.save();
		this.contentEl.empty();
		this.onClosed?.();
	}

	private async add(): Promise<void> {
		this.templates.push({ name: '', prompt: '' });
		this.selected = this.templates.length - 1;
		await this.save();
		this.render();
		this.editorEl.querySelector<HTMLInputElement>('.local-llm-templates-name')?.focus();
	}

	private async remove(index: number): Promise<void> {
		this.templates.splice(index, 1);
		this.selected = Math.min(this.selected, this.templates.length - 1);
		await this.save();
		this.render();
	}

	private render(): void {
		this.renderList();
		this.renderEditor();
	}

	private renderList(): void {
		this.listEl.empty();
		if (this.templates.length === 0) {
			this.listEl.createEl('div', { cls: 'local-llm-templates-empty', text: 'No templates yet.' });
			return;
		}
		this.templates.forEach((template, index) => {
			const item = this.listEl.createEl('div', {
				cls: 'local-llm-templates-item' + (index === this.selected ? ' is-selected' : ''),
				attr: { role: 'option', 'aria-selected': String(index === this.selected), tabindex: '0' },
			});
			item.createEl('div', { cls: 'local-llm-templates-item-name', text: template.name ? `/${template.name}` : 'Untitled' });
			item.createEl('div', { cls: 'local-llm-templates-item-preview', text: previewPrompt(template.prompt, 48) || 'No text yet' });
			const pick = () => {
				this.selected = index;
				this.render();
			};
			item.addEventListener('click', pick);
			item.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					pick();
				}
			});
		});
	}

	private renderEditor(): void {
		this.editorEl.empty();
		const template = this.templates[this.selected];
		if (!template) {
			this.editorEl.createEl('div', {
				cls: 'local-llm-templates-placeholder',
				text: 'Click New template to save a prompt you use often, such as "Summarize this note in five bullet points."',
			});
			return;
		}

		this.editorEl.createEl('label', { cls: 'local-llm-templates-label', text: 'Name', attr: { for: 'local-llm-template-name' } });
		const nameRow = this.editorEl.createEl('div', { cls: 'local-llm-templates-name-row' });
		nameRow.createEl('span', { cls: 'local-llm-templates-slash', text: '/' });
		const nameInput = nameRow.createEl('input', {
			cls: 'local-llm-templates-name',
			attr: { id: 'local-llm-template-name', type: 'text', placeholder: 'summarize', spellcheck: 'false' },
		});
		nameInput.value = template.name;
		const warning = this.editorEl.createEl('div', { cls: 'local-llm-templates-warning' });
		const checkDuplicate = () => {
			const dup = template.name && this.templates.some((t, i) => i !== this.selected && t.name === template.name);
			warning.setText(dup ? `Another template is already called /${template.name}.` : '');
		};
		checkDuplicate();
		nameInput.addEventListener('input', () => {
			// Names are typed after "/", so they can't hold spaces.
			const clean = templateName(nameInput.value);
			if (clean !== nameInput.value) {
				const pos = nameInput.selectionStart ?? clean.length;
				nameInput.value = clean;
				nameInput.setSelectionRange(Math.min(pos, clean.length), Math.min(pos, clean.length));
			}
			template.name = clean;
			checkDuplicate();
			this.renderList();
			void this.save();
		});

		this.editorEl.createEl('label', { cls: 'local-llm-templates-label', text: 'Prompt', attr: { for: 'local-llm-template-prompt' } });
		const promptInput = this.editorEl.createEl('textarea', {
			cls: 'local-llm-templates-prompt',
			attr: { id: 'local-llm-template-prompt', rows: '8', placeholder: 'Summarize this note in five bullet points.' },
		});
		promptInput.value = template.prompt;
		promptInput.addEventListener('input', () => {
			template.prompt = promptInput.value;
			this.renderList();
			void this.save();
		});

		const footer = this.editorEl.createEl('div', { cls: 'local-llm-templates-footer' });
		footer.createEl('span', { cls: 'local-llm-templates-saved', text: 'Changes are saved automatically.' });
		const del = footer.createEl('button', { cls: 'mod-warning local-llm-templates-delete', attr: { 'aria-label': 'Delete template' } });
		setIcon(del.createEl('span'), 'trash');
		del.createEl('span', { text: 'Delete' });
		del.addEventListener('click', () => void this.remove(this.selected));
	}
}
