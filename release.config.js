export default {
  branches: ["main", { name: "alpha", prerelease: "alpha" }],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { pkgRoot: "packages/nostr-relay" }],
    ["@semantic-release/npm", { pkgRoot: "packages/nostr-relay-aws" }],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["packages/nostr-relay/package.json", "packages/nostr-relay-aws/package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }
    ]
  ]
}
