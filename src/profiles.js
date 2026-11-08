'use strict';
const CONFIG = 'CLAUDE_CONFIG_DIR';
const AUTH = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
function withDirectory(entries, directory) {
  return [...entries.filter(e => e.name !== CONFIG), { name: CONFIG, value: directory }];
}
function restoreDirectory(entries, original) {
  return [...entries.filter(e => e.name !== CONFIG), ...original];
}
function conflicts(entries, inherited = {}) {
  return AUTH.filter(name => entries.some(e => e.name === name && e.value) || inherited[name]);
}
function defaultProfile(directoryEntries, inheritedDirectory, homeDirectory) {
  const configValue = directoryEntries.find(e => e.name === CONFIG)?.value || inheritedDirectory || null;
  return { id: 'builtin-default', name: 'Default', builtin: true, directory: configValue || require('node:path').join(homeDirectory, '.claude'), configValue, directoryEntries };
}
function panelEntries(entries, profile) {
  return profile.builtin ? restoreDirectory(entries, profile.directoryEntries) : withDirectory(entries, profile.directory);
}
module.exports = { CONFIG, AUTH, withDirectory, restoreDirectory, conflicts, defaultProfile, panelEntries };
