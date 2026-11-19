const STOPWORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
	'how', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
	'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/** Light English stemmer: enough to match plural/tense variants without a dictionary. */
export function stem(word: string): string {
	if (word.length <= 3 || /\d/.test(word)) return word;
	const rules: Array<[RegExp, string]> = [
		[/ies$/, 'y'],
		[/(ss|sh|ch|x|z)es$/, '$1'],
		[/([^s])s$/, '$1'],
		[/eed$/, 'ee'],
		[/([aeiou].*)ing$/, '$1'],
		[/([aeiou].*)ed$/, '$1'],
		[/ment$/, ''],
		[/ly$/, ''],
	];
	for (const [re, rep] of rules) {
		if (re.test(word)) {
			const out = word.replace(re, rep);
			// Undo doubled consonants left by -ing/-ed ("stopped" -> "stopp" -> "stop").
			const fixed = /([b-df-hj-np-tv-z])\1$/.test(out) && !/(ll|ss|zz)$/.test(out) ? out.slice(0, -1) : out;
			return fixed.length >= 3 ? fixed : word;
		}
	}
	return word;
}

/** Removes markdown syntax that adds noise but no meaning. */
export function stripMarkdown(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ' '))
		.replace(/!\[\[([^\]]*)\]\]/g, ' $1 ')
		.replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, ' $1 $2 ')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
		.replace(/[#>*_`~=|-]+/g, ' ');
}

export function tokenize(text: string, opts: { keepStopwords?: boolean } = {}): string[] {
	const words = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
	const out: string[] = [];
	for (const w of words) {
		if (!opts.keepStopwords && STOPWORDS.has(w)) continue;
		out.push(stem(w));
	}
	return out;
}
