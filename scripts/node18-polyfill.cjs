// Node 18.18 exports File from node:buffer but doesn't register it globally, which some of
// vsce's dependencies (undici) expect. This is a build-tool-only shim for running `vsce package`
// on Node 18 — it never ships in the extension itself.
if (typeof globalThis.File === 'undefined') {
  globalThis.File = require('node:buffer').File;
}
