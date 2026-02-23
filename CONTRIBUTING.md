# Contributing

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for automated versioning and releases. Commit messages determine the next release version:

| Type | Version bump | Example |
|------|--------------|---------|
| `feat:` | MINOR (0.2.0) | `feat: add NIP-04 encryption` |
| `fix:` | PATCH (0.1.1) | `fix: handle empty filter arrays` |
| `feat!:` or footer `BREAKING CHANGE:` | MAJOR (1.0.0) | `feat!: change filter API` |
| `docs:`, `chore:`, `ci:`, `refactor:`, `test:` | none | `chore: update deps` |

## Releases

Releases are automated via [semantic-release](https://github.com/semantic-release/semantic-release) when changes are merged to `main`. No manual version bumping or `npm publish` is required.
