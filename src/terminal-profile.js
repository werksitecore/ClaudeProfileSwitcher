'use strict';
const { CONFIG, AUTH } = require('./profiles');

function syncTerminalProfile(collection, directory) {
  if (!collection) return;
  // Rebuild the override from current settings on each extension-host start.
  collection.persistent = false;
  if (directory) collection.replace(CONFIG, directory, { applyAtProcessCreation: true, applyAtShellIntegration: false });
  else collection.delete(CONFIG);
}

function profileTerminalOptions(profile, inherited, login = false, session) {
  const env = { ...inherited };
  // Windows environment keys are case-insensitive. Remove all spellings first.
  const removed = new Set([CONFIG, ...AUTH]);
  for (const key of Object.keys(env)) if (removed.has(key.toUpperCase())) delete env[key];
  const directory = profile.builtin ? profile.configValue : profile.directory;
  if (directory) env[CONFIG] = directory;
  return {
    name: `Claude: ${profile.name}${login ? ' (login)' : ''}`,
    shellPath: 'claude',
    shellArgs: login ? ['auth', 'login'] : session ? ['--resume', session.id] : [],
    cwd: session?.cwd,
    // Prevent the active panel's terminal collection from replacing an explicitly
    // selected CLI profile. Supply the ordinary process environment ourselves.
    strictEnv: true,
    env
  };
}

module.exports = { syncTerminalProfile, profileTerminalOptions };
