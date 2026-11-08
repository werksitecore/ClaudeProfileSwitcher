const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listSessions, transferSession, transferWorkspace } = require('../src/history');
const id = '12345678-1234-1234-1234-123456789abc';
const project = 'test-project';
const relative = path.join('projects', project, id + '.jsonl');
const transcript = content => JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), message: { role: 'user', content } }) + '\n';
async function fixture(t) {
  const base = path.join(__dirname, '..', '.test-tmp');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  await fs.mkdir(path.join(source, 'projects', project), { recursive: true });
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, relative), transcript('first'));
  return { root, source, destination, session: { id, project, cwd: process.cwd() } };
}
test('round trip preserves same session ID, source bytes and both previous branches', async t => {
  const { source, destination, session } = await fixture(t);
  const first = await transferSession(source, destination, session);
  assert.equal(await fs.readFile(path.join(source, relative), 'utf8'), transcript('first'));
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), transcript('first'));
  assert.equal(await fs.readFile(path.join(first.backup, 'incoming', relative), 'utf8'), transcript('first'));
  const continued = transcript('first') + transcript('continued in second account');
  await fs.writeFile(path.join(destination, relative), continued);
  const second = await transferSession(destination, source, session);
  assert.equal(second.id, id);
  assert.equal(await fs.readFile(path.join(source, relative), 'utf8'), continued);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), continued);
  assert.equal(await fs.readFile(path.join(second.backup, 'previous', relative), 'utf8'), transcript('first'));
  assert.equal(JSON.parse(await fs.readFile(path.join(second.backup, 'manifest.json'))).state, 'committed');
});
test('copies selected session sidecars and checkpoints, not credentials or other sessions', async t => {
  const { source, destination, session } = await fixture(t);
  for (const file of [path.join('projects', project, id, 'subagents', 'agent-one.jsonl'), path.join('file-history', id, 'snapshot')]) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), 'fixture');
  }
  await fs.writeFile(path.join(source, '.credentials.json'), 'do-not-copy');
  await transferSession(source, destination, session);
  assert.equal(await fs.readFile(path.join(destination, 'file-history', id, 'snapshot'), 'utf8'), 'fixture');
  await assert.rejects(fs.access(path.join(destination, '.credentials.json')));
});
test('invalid partial transcript fails without touching destination history', async t => {
  const { source, destination, session } = await fixture(t);
  await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await fs.writeFile(path.join(destination, relative), 'existing');
  await fs.appendFile(path.join(source, relative), '{partial');
  await assert.rejects(transferSession(source, destination, session), /Incomplete/);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), 'existing');
  await assert.rejects(fs.access(path.join(destination, '.profile-switch-lock')));
});
test('session picker filters to open project and sorts newest first', async t => {
  const { source } = await fixture(t);
  const sessions = await listSessions(source, [process.cwd()]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  assert.deepEqual(await listSessions(source, [path.join(os.tmpdir(), 'different-project')]), []);
});
test('rejects traversal and concurrent transfer locks', async t => {
  const { source, destination, session } = await fixture(t);
  await assert.rejects(transferSession(source, destination, { ...session, project: '..' }), /Invalid/);
  await fs.mkdir(path.join(destination, '.profile-switch-lock'));
  await assert.rejects(transferSession(source, destination, session), /Another transfer/);
});
test('rejects directory junctions without modifying linked history', async t => {
  const { root, source, destination, session } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(destination, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(transferSession(source, destination, session), /Linked history/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('commit failure rolls back the previous destination transcript', async t => {
  const { source, destination, session } = await fixture(t);
  await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await fs.writeFile(path.join(destination, relative), transcript('destination branch'));
  const sidecar = path.join(source, 'projects', project, id);
  await fs.mkdir(sidecar);
  await fs.writeFile(path.join(sidecar, 'data.json'), '{}');
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from.includes(`${path.sep}stage${path.sep}`) && from.endsWith(id)) throw new Error('Simulated disk failure');
    return originalRename(from, to);
  });
  await assert.rejects(transferSession(source, destination, session), /Simulated/);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), transcript('destination branch'));
  assert.equal(await fs.readFile(path.join(source, relative), 'utf8'), transcript('first'));
});
test('workspace switch carries multiple chats without identifying the active tab', async t => {
  const { source, destination, session } = await fixture(t);
  const secondId = '22345678-1234-1234-1234-123456789abc';
  await fs.writeFile(path.join(source, 'projects', project, secondId + '.jsonl'), transcript('second chat').replaceAll(id, secondId));
  const sessions = await listSessions(source, [process.cwd()]);
  const copied = await transferWorkspace(source, destination, sessions);
  assert.equal(copied.length, 2);
  for (const s of sessions) {
    const file = path.join('projects', project, s.id + '.jsonl');
    assert.deepEqual(await fs.readFile(path.join(destination, file)), await fs.readFile(path.join(source, file)));
  }
  assert.equal(session.id, id);
});
test('workspace preflight rejects malformed later history before copying any chat', async t => {
  const { source, destination, session } = await fixture(t);
  const second = { ...session, id: '22345678-1234-1234-1234-123456789abc' };
  await fs.writeFile(path.join(source, 'projects', project, second.id + '.jsonl'), '{bad');
  await assert.rejects(transferWorkspace(source, destination, [session, second]), /Incomplete/);
  assert.deepEqual(await fs.readdir(destination), []);
});
