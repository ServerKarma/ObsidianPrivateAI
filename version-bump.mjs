import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Read current manifest
const manifestPath = path.join(process.cwd(), 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Get current version
const currentVersion = manifest.version;
const [major, minor, patch] = currentVersion.split('.').map(Number);

// Increment patch version
const newVersion = `${major}.${minor}.${patch + 1}`;

// Stop before touching anything if this version was already released, so a re-run
// after a failed push can't leave a second bump commit behind.
const run = (command) => execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tagExistsLocally = (() => {
  try {
    run(`git rev-parse -q --verify refs/tags/${newVersion}`);
    return true;
  } catch {
    return false;
  }
})();
const tagExistsOnRemote = run(`git ls-remote --tags origin refs/tags/${newVersion}`) !== '';
if (tagExistsLocally || tagExistsOnRemote) {
  console.error(`Tag ${newVersion} already exists ${tagExistsOnRemote ? 'on origin' : 'locally'}. Nothing was changed.`);
  console.error(`If manifest.json is behind the latest release, set its version to that release and run this again.`);
  process.exit(1);
}

// Update manifest
manifest.version = newVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// Update package.json
const packagePath = path.join(process.cwd(), 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
packageJson.version = newVersion;
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

console.log(`Version bumped from ${currentVersion} to ${newVersion}`);
execSync(`git add manifest.json package.json`, { stdio: 'inherit' });
execSync(`git commit -m "Bump version to ${newVersion}"`, { stdio: 'inherit' });

// Git tag and push
console.log(`Creating git tag ${newVersion}...`);
execSync(`git tag ${newVersion}`, { stdio: 'inherit' });

// Push the branch and only the new tag, together. `git push --tags` would send every
// local tag, and is rejected when an old local tag differs from the one on origin.
console.log(`Pushing main and tag ${newVersion} to remote...`);
execSync(`git push --atomic origin HEAD:main refs/tags/${newVersion}`, { stdio: 'inherit' });

// Wait 30 seconds
console.log('Waiting 60 seconds for GitHub action to create the release...');
await new Promise(resolve => setTimeout(resolve, 60000));

// Open releases page in browser
const releaseUrl = 'https://github.com/gabosgab/ObsidianPrivateAI/releases';
console.log(`Opening ${releaseUrl} in browser...`);

// Cross-platform browser opening
const platform = process.platform;
let openCommand;

if (platform === 'darwin') {
  openCommand = `open "${releaseUrl}"`;
} else if (platform === 'win32') {
  openCommand = `start "" "${releaseUrl}"`;
} else {
  openCommand = `xdg-open "${releaseUrl}"`;
}

execSync(openCommand, { stdio: 'inherit' });
console.log('Done!');
