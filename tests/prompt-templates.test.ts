import { describe, expect, it } from 'vitest';
import { cleanTemplates, matchTemplates, previewPrompt, slashQuery } from '../src/views/promptTemplates';
import { PromptTemplatePicker } from '../src/views/PromptTemplatePicker';

const TEMPLATES = [
  { name: 'summarize', prompt: 'Summarize the active note in five bullet points.' },
  { name: 'todo', prompt: 'List every open task in my notes.' },
  { name: 'translate-es', prompt: 'Translate this note to Spanish.' },
  { name: '', prompt: 'nameless' },
  { name: 'empty', prompt: '   ' },
];

describe('prompt template matching', () => {
  it('opens only for a leading slash with no space yet', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/sum')).toBe('sum');
    expect(slashQuery('/sum this')).toBeNull();
    expect(slashQuery('hello /sum')).toBeNull();
    expect(slashQuery('')).toBeNull();
  });

  it('drops unusable templates and ranks prefix, then substring, then prompt matches', () => {
    expect(cleanTemplates(TEMPLATES).map((t) => t.name)).toEqual(['summarize', 'todo', 'translate-es']);
    expect(matchTemplates('', TEMPLATES).map((t) => t.name)).toEqual(['summarize', 'todo', 'translate-es']);
    expect(matchTemplates('T', TEMPLATES).map((t) => t.name)).toEqual(['todo', 'translate-es']);
    expect(matchTemplates('es', TEMPLATES).map((t) => t.name)).toEqual(['translate-es']);
    expect(matchTemplates('spanish', TEMPLATES).map((t) => t.name)).toEqual(['translate-es']);
    expect(matchTemplates('x', undefined)).toEqual([]);
  });

  it('previews one shortened line', () => {
    expect(previewPrompt('a\n  b', 80)).toBe('a b');
    expect(previewPrompt('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});

describe('PromptTemplatePicker', () => {
  function setup(templates = TEMPLATES) {
    const container = document.createElement('div');
    const input = container.createEl('textarea') as HTMLTextAreaElement;
    const sent: string[] = [];
    const picker = new PromptTemplatePicker(input, container, () => templates);
    // The chat's own Enter-to-send listener, added after the picker like in ChatView.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) sent.push(input.value);
    });
    const type = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const key = (k: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true }));
    const menu = () => container.querySelector('.local-llm-template-menu') as HTMLElement;
    return { input, picker, sent, type, key, menu };
  }

  it('lists templates on "/" and narrows as you type', () => {
    const { picker, type, menu } = setup();
    type('/');
    expect(picker.listedNames).toEqual(['summarize', 'todo', 'translate-es']);
    expect(menu().classList.contains('local-llm-template-menu-visible')).toBe(true);
    type('/to');
    expect(picker.listedNames).toEqual(['todo']);
    type('/to do');
    expect(picker.isOpen).toBe(false);
    expect(menu().classList.contains('local-llm-template-menu-hidden')).toBe(true);
  });

  it('puts the chosen template in the box on Enter without sending it', () => {
    const { input, sent, type, key, picker } = setup();
    type('/');
    key('ArrowDown');
    key('Enter');
    expect(input.value).toBe('List every open task in my notes.');
    expect(sent).toEqual([]);
    expect(picker.isOpen).toBe(false);
    key('Enter');
    expect(sent).toEqual(['List every open task in my notes.']);
  });

  it('wraps with arrow keys, picks with Tab, and chooses by mouse', () => {
    const { input, type, key, menu } = setup();
    type('/');
    key('ArrowUp');
    key('Tab');
    expect(input.value).toBe('Translate this note to Spanish.');
    type('/s');
    const first = menu().querySelector('.local-llm-template-item') as HTMLElement;
    expect(first.textContent).toContain('/summarize');
    first.dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
    expect(input.value).toBe('Summarize the active note in five bullet points.');
  });

  it('stays closed after Escape until the text changes, and sends "/x" as typed when nothing matches', () => {
    const { picker, sent, type, key } = setup();
    type('/su');
    key('Escape');
    expect(picker.isOpen).toBe(false);
    type('/su');
    expect(picker.isOpen).toBe(false);
    type('/sum');
    expect(picker.isOpen).toBe(true);
    type('/zzz');
    expect(picker.isOpen).toBe(false);
    key('Enter');
    expect(sent).toEqual(['/zzz']);
  });

  it('never opens without templates', () => {
    const { picker, type } = setup([]);
    type('/');
    expect(picker.isOpen).toBe(false);
  });
});

describe('PromptTemplatesModal', () => {
  async function setup(templates: { name: string; prompt: string }[]) {
    const { PromptTemplatesModal } = await import('../src/views/PromptTemplatesModal');
    let saves = 0;
    let closed = 0;
    const modal = new PromptTemplatesModal({} as any, templates, async () => { saves++; }, () => { closed++; });
    modal.open();
    const el = modal.modalEl;
    const names = () => [...el.querySelectorAll('.local-llm-templates-item-name')].map((e) => e.textContent);
    const type = (sel: string, value: string) => {
      const input = el.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    return { modal, el, names, type, saves: () => saves, closed: () => closed };
  }

  it('lists templates and edits the selected one in place', async () => {
    const templates = [
      { name: 'summarize', prompt: 'Summarize this.' },
      { name: 'todo', prompt: 'List tasks.' },
    ];
    const { el, names, type, saves } = await setup(templates);
    expect(names()).toEqual(['/summarize', '/todo']);
    expect((el.querySelector('.local-llm-templates-name') as HTMLInputElement).value).toBe('summarize');

    (el.querySelectorAll('.local-llm-templates-item')[1] as HTMLElement).click();
    expect((el.querySelector('.local-llm-templates-prompt') as HTMLTextAreaElement).value).toBe('List tasks.');
    type('.local-llm-templates-name', 'open tasks');
    type('.local-llm-templates-prompt', 'List every open task.');
    expect(templates[1]).toEqual({ name: 'open-tasks', prompt: 'List every open task.' });
    expect(names()).toEqual(['/summarize', '/open-tasks']);
    expect(saves()).toBe(2);
  });

  it('adds, warns on a duplicate name, and deletes', async () => {
    const templates = [{ name: 'todo', prompt: 'List tasks.' }];
    const { el, names, type } = await setup(templates);
    (el.querySelector('.local-llm-templates-add') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(names()).toEqual(['/todo', 'Untitled']);
    type('.local-llm-templates-name', 'todo');
    expect(el.querySelector('.local-llm-templates-warning')?.textContent).toContain('/todo');

    (el.querySelector('.local-llm-templates-delete') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(templates).toEqual([{ name: 'todo', prompt: 'List tasks.' }]);
    expect(names()).toEqual(['/todo']);
  });

  it('drops a template left empty when the window closes', async () => {
    const templates = [{ name: 'todo', prompt: 'List tasks.' }];
    const { modal, el, closed } = await setup(templates);
    (el.querySelector('.local-llm-templates-add') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(templates.length).toBe(2);
    modal.close();
    expect(templates).toEqual([{ name: 'todo', prompt: 'List tasks.' }]);
    expect(closed()).toBe(1);
  });

  it('shows a hint when there are no templates', async () => {
    const { el } = await setup([]);
    expect(el.querySelector('.local-llm-templates-empty')?.textContent).toBe('No templates yet.');
    expect(el.querySelector('.local-llm-templates-placeholder')).not.toBeNull();
  });
});
