### Release Instructions

Releases are automatic. Every push to `main` runs the **Auto release** workflow (`.github/workflows/auto-release.yml`):

1. It picks the version (`.github/scripts/release-version.mjs`). If `manifest.json`'s version is already released, it bumps the patch number in `manifest.json` and `package.json` and commits "Bump version to x.y.z" back to `main`. If you bumped the version yourself, that version is used as is.
2. It builds the plugin and runs the unit tests. Nothing is released if either fails.
3. It tags the commit and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`, marked as the latest release, with notes generated from the merged pull requests.

### Manual release (optional)

`npm run release` still works: it bumps the version, tags it and pushes `main` and the tag. The Auto release workflow sees the commit is already tagged and publishes that version as is, without another bump. A version that already has a release is never published twice.
