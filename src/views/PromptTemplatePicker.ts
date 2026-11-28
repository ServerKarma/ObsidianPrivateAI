import { PromptTemplate, matchTemplates, previewPrompt, slashQuery } from './promptTemplates';

/**
 * The "/" menu of the chat box. Typing "/" at the start of an empty box lists the saved
 * prompt templates; typing more narrows the list. Up/Down move, Enter or Tab puts the
 * template's text in the box (it is not sent), Escape closes the menu.
 *
 * Its keydown listener must be added before the chat's Enter-to-send listener, so that
 * Enter picks a template instead of sending "/name".
 */
export class PromptTemplatePicker {
	private readonly menuEl: HTMLElement;
	private items: PromptTemplate[] = [];
	private selected = 0;
	/** Set by Escape; the menu stays closed until the text changes. */
	private dismissedFor: string | null = null;

	constructor(
		private readonly input: HTMLTextAreaElement,
		container: HTMLElement,
		private readonly getTemplates: () => PromptTemplate[] | undefined,
		/** Opens the templates window; shown as the menu's last line when given. */
		private readonly onManage?: () => void,
	) {
		this.menuEl = container.createEl('div', {
			cls: 'local-llm-template-menu local-llm-template-menu-hidden',
			attr: { role: 'listbox', 'aria-label': 'Prompt templates' },
		});
		input.addEventListener('input', () => this.update());
		input.addEventListener('keydown', (e) => this.onKeyDown(e));
		input.addEventListener('blur', () => {
			// Let a click on a menu item land before the menu goes away.
			window.setTimeout(() => this.close(), 150);
		});
	}

	get isOpen(): boolean {
		return this.items.length > 0;
	}

	/** Names currently listed, for tests. */
	get listedNames(): string[] {
		return this.items.map((t) => t.name);
	}

	update(): void {
		const value = this.input.value;
		if (this.dismissedFor !== null && this.dismissedFor !== value) this.dismissedFor = null;
		const query = slashQuery(value);
		if (query === null || this.dismissedFor === value) {
			this.close();
			return;
		}
		const items = matchTemplates(query, this.getTemplates());
		if (items.length === 0) {
			this.close();
			return;
		}
		const keep = this.items[this.selected]?.name;
		this.items = items;
		const again = keep ? items.findIndex((t) => t.name === keep) : -1;
		this.selected = again >= 0 ? again : 0;
		this.render();
	}

	close(): void {
		this.items = [];
		this.selected = 0;
		this.menuEl.empty();
		this.menuEl.removeClass('local-llm-template-menu-visible');
		this.menuEl.addClass('local-llm-template-menu-hidden');
	}

	/** Puts a template's text in the chat box, ready to edit or send. */
	choose(template: PromptTemplate): void {
		this.input.value = template.prompt;
		this.close();
		this.input.focus();
		const end = template.prompt.length;
		this.input.setSelectionRange(end, end);
		this.input.dispatchEvent(new Event('input'));
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (!this.isOpen) return;
		let handled = true;
		if (e.key === 'ArrowDown') {
			this.selected = (this.selected + 1) % this.items.length;
			this.render();
		} else if (e.key === 'ArrowUp') {
			this.selected = (this.selected - 1 + this.items.length) % this.items.length;
			this.render();
		} else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
			this.choose(this.items[this.selected]);
		} else if (e.key === 'Escape') {
			this.dismissedFor = this.input.value;
			this.close();
		} else {
			handled = false;
		}
		if (handled) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	}

	private render(): void {
		this.menuEl.empty();
		this.menuEl.removeClass('local-llm-template-menu-hidden');
		this.menuEl.addClass('local-llm-template-menu-visible');
		this.items.forEach((template, index) => {
			const item = this.menuEl.createEl('div', {
				cls: 'local-llm-template-item' + (index === this.selected ? ' is-selected' : ''),
				attr: { role: 'option', 'aria-selected': String(index === this.selected) },
			});
			item.createEl('div', { cls: 'local-llm-template-name', text: `/${template.name}` });
			item.createEl('div', { cls: 'local-llm-template-preview', text: previewPrompt(template.prompt) });
			// mousedown, not click: it fires before the box loses focus.
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this.choose(template);
			});
		});
		if (this.onManage) {
			const manage = this.menuEl.createEl('div', { cls: 'local-llm-template-manage', text: 'Manage templates…' });
			manage.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this.input.value = '';
				this.close();
				this.onManage?.();
			});
		}
	}
}
