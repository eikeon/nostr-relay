#!/usr/bin/env node
// Wrapper so pnpm can create the bin symlink at install time (dist may not exist yet)
import "../dist/bin/nostr-relay.js"
