'use strict';
const path = require('node:path');
const { CONFIG } = require('./profiles');
function managedDirectory(value, home, profiles = []) {
  if (typeof value !== 'string' || !value) return false;
  const canonical = input => path.resolve(input).toLowerCase();
  const root = canonical(path.join(home, '.claude-profile-switcher', 'profiles'));
  const candidate = canonical(value);
  return candidate === root || candidate.startsWith(root + path.sep) || profiles.some(p => canonical(p.directory) === candidate);
}
function recoveryConfiguration({ defaults, original, entries, inherited, home, profiles }) {
  const saved = defaults?.directoryEntries ?? original?.directoryEntries ?? entries.filter(e => e.name === CONFIG);
  // Never adopt one of our managed accounts as the original setup, including
  // after extension storage loss or an upgrade from a contaminated baseline.
  const directoryEntries = saved.filter(e => e.name === CONFIG && typeof e.value === 'string' && !managedDirectory(e.value, home, profiles));
  const inheritedDirectory = defaults?.inheritedDirectory ?? inherited ?? null;
  if (managedDirectory(inheritedDirectory, home, profiles)) {
    throw new Error('VS Code inherited a switcher profile directory from its launch environment. Start VS Code without CLAUDE_CONFIG_DIR before restoring Default.');
  }
  return { directoryEntries, inheritedDirectory };
}
module.exports = { managedDirectory, recoveryConfiguration };
