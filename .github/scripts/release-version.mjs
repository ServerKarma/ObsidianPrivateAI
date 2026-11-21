// Picks the version for the automatic release of a push to main (.github/workflows/auto-release.yml).
//
// - If this commit is already tagged with the manifest version (a manual `npm run release`),
//   release that tag as is: tagged=true.
// - If the manifest version is not tagged yet (someone bumped it by hand), release it as is.
// - Otherwise bump the patch number until it is free, and write it to manifest.json and
//   package.json the same way version-bump.mjs does: bumped=true.
//
// Writes version, bumped and tagged to $GITHUB_OUTPUT (or prints them when run locally).
// Needs the repository's tags: check out with fetch-depth 0.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const root = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const tags = new Set(git('tag', '--list').split('\n').filter(Boolean));
const tagsHere = new Set(git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean));

const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const current = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(current)) {
	console.error(`manifest.json version "${current}" is not x.y.z`);
	process.exit(1);
}

let version = current;
let bumped = false;
let tagged = false;

if (tagsHere.has(current)) {
	tagged = true;
} else if (tags.has(current)) {
	const [major, minor, patch] = current.split('.').map(Number);
	let next = patch + 1;
	while (tags.has(`${major}.${minor}.${next}`)) next++;
	version = `${major}.${minor}.${next}`;
	bumped = true;

	manifest.version = version;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	const packagePath = path.join(root, 'package.json');
	const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
	packageJson.version = version;
	fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
}

const lines = [`version=${version}`, `bumped=${bumped}`, `tagged=${tagged}`];
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
console.log(lines.join('\n'));
