const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.run = async () => {
  const root = path.resolve(__dirname, '..');
  const phase = process.env.SWITCHER_TEST_PHASE || 'first';
  const events = [];
  try {
    assert.equal(path.resolve(process.env.USERPROFILE).toLowerCase(), path.join(root, 'home').toLowerCase());
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
    const driver = await vscode.extensions.getExtension('fixture.isolated-switcher-tests').activate();
    const context = driver.context;
    const managed = path.join(root, 'home', '.claude-profile-switcher', 'profiles', 'work');
    const baseline = path.join(root, 'home', '.claude');
    const config = vscode.workspace.getConfiguration('claudeCode');
    const marker = 'SYNTHETIC HISTORY — DO NOT CHANGE';
    if (phase !== 'restart') {
      await fs.mkdir(baseline, { recursive: true });
      await fs.writeFile(path.join(baseline, 'history-fixture.txt'), marker);
      // Reproduce lost profile registrations plus contaminated recovery snapshots.
      await context.globalState.update('profiles', []);
      await context.globalState.update('original', undefined);
      await context.globalState.update('defaultConfiguration', { directoryEntries: [{ name: 'CLAUDE_CONFIG_DIR', value: managed }], inheritedDirectory: null });
      await config.update('environmentVariables', [{ name: 'CLAUDE_CONFIG_DIR', value: managed }, { name: 'FIXTURE_KEEP', value: 'yes' }], vscode.ConfigurationTarget.Global);
    } else {
      assert.deepEqual(vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'), [{ name: 'FIXTURE_KEEP', value: 'yes' }]);
      events.push('restored settings persisted across a real VS Code restart');
    }
    await require(phase === 'baseline' ? path.join(root, 'baseline', 'extension.js') : path.resolve(root, '../src/extension.js')).activate(context);
    if (phase !== 'baseline') {
      assert.deepEqual(context.globalState.get('defaultConfiguration').directoryEntries, []);
      events.push('managed directory not adopted as Default');
    }
    // No Claude extension or chat tab exists. Execute the real registered command.
    void vscode.commands.executeCommand('claudeProfiles.restore');
    for (let i = 0; i < 100 && vscode.workspace.getConfiguration('claudeCode').get('environmentVariables').some(e => e.name === 'CLAUDE_CONFIG_DIR'); i++) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'), [{ name: 'FIXTURE_KEEP', value: 'yes' }]);
    assert.equal(await fs.readFile(path.join(baseline, 'history-fixture.txt'), 'utf8'), marker);
    events.push('restore works without Claude installed or any Claude tab');
    events.push('unrelated setting and synthetic history preserved');
    await fs.writeFile(path.join(root, `result-${phase}.json`), JSON.stringify({ status: 'pass', phase, vscode: vscode.version, events }, null, 2));
  } catch (error) {
    await fs.writeFile(path.join(root, `result-${phase}.json`), JSON.stringify({ status: 'fail', phase, events, error: error.stack }, null, 2));
    throw error;
  }
};

