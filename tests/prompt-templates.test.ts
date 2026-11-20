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
