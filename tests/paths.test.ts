/**
 * tests/paths.test.ts — where the engine writes (ADR 0134): each location's
 * own variable wins, MELCHIZEDEK_DATA_DIR roots the defaults, and without
 * either the historical defaults hold. inspect_image reads what
 * generate_image reports, wherever the outputs directory is, and nothing
 * outside it; the engine version comes from the engine's own package.json
 * whatever the working directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { chatGptSignInFile, dataDir, enginePackageRoot, outputsDir, tasksFile } from '../lib/paths.ts';
import { resolveOutputPath } from '../lib/tools/inspectImageTool.ts';
import { signInFile } from '../lib/chatgpt/state.ts';
import { engineVersion } from '../lib/observability/lineage.ts';

const DATA = join(tmpdir(), 'melch-data');

test('with no variable, the historical defaults', () => {
  const env = {};
  assert.equal(dataDir(env), undefined);
  assert.equal(outputsDir(env), join(process.cwd(), 'outputs'));
  assert.equal(tasksFile(env), join(process.cwd(), 'outputs', 'tasks.json'));
  assert.equal(chatGptSignInFile(env), join(homedir(), '.melchizedek', 'chatgpt-signin.json'));
});

test('MELCHIZEDEK_DATA_DIR roots every default', () => {
  const env = { MELCHIZEDEK_DATA_DIR: DATA };
  assert.equal(outputsDir(env), join(DATA, 'outputs'));
  assert.equal(tasksFile(env), join(DATA, 'outputs', 'tasks.json'));
  assert.equal(chatGptSignInFile(env), join(DATA, 'chatgpt-signin.json'));
  assert.equal(signInFile(env), join(DATA, 'chatgpt-signin.json'), 'the sign-in module reads the same');
});

test('each location\'s own variable wins over the data directory', () => {
  const env = { MELCHIZEDEK_DATA_DIR: DATA, OUTPUTS_DIR: '/srv/out', MELCHIZEDEK_TASKS_FILE: '/srv/tasks.json', MELCHIZEDEK_CHATGPT_SIGNIN_FILE: '/srv/signin.json' };
  assert.equal(outputsDir(env), resolve('/srv/out'));
  assert.equal(tasksFile(env), resolve('/srv/tasks.json'));
  assert.equal(chatGptSignInFile(env), resolve('/srv/signin.json'));
  // OUTPUTS_DIR alone does not move the task file (an existing deployment's tasks stay put).
  assert.equal(tasksFile({ OUTPUTS_DIR: '/srv/out' }), join(process.cwd(), 'outputs', 'tasks.json'));
});

test('inspect_image reads the path generate_image reports, inside the outputs directory wherever it is', () => {
  const saved = process.env.OUTPUTS_DIR;
  process.env.OUTPUTS_DIR = join(DATA, 'elsewhere');
  try {
    const out = outputsDir();
    assert.equal(resolveOutputPath('outputs/image_1.png'), join(out, 'image_1.png'), 'generate_image reports outputs/<file>');
    assert.equal(resolveOutputPath('./outputs/image_1.png'), join(out, 'image_1.png'));
    assert.equal(resolveOutputPath('image_1.png'), join(out, 'image_1.png'));
    for (const escape of ['outputs/../../etc/passwd', '../secret.png', '/etc/passwd']) {
      assert.ok(!resolveOutputPath(escape).startsWith(out + '/'), `${escape} stays outside, for the confinement check to refuse`);
    }
  } finally {
    if (saved === undefined) delete process.env.OUTPUTS_DIR;
    else process.env.OUTPUTS_DIR = saved;
  }
});

test('the engine version is the engine\'s own, whatever the working directory', () => {
  const root = enginePackageRoot();
  assert.ok(root);
  const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
  const cwd = process.cwd();
  process.chdir(tmpdir());
  try {
    assert.ok(engineVersion().startsWith(`${own}+`), engineVersion());
  } finally {
    process.chdir(cwd);
  }
});
