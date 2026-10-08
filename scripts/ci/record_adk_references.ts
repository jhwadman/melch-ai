/**
 * scripts/ci/record_adk_references.ts — records ADK's reference behaviour for
 * the parity suites into tests/fixtures/adk-reference (WS5-2a), or checks the
 * recorded files for drift. Needs @google/adk installed; never shipped (the
 * package's `files` holds no scripts/).
 *
 *   npm run fixtures:adk:record   # rewrite tests/fixtures/adk-reference
 *   npm run fixtures:adk:check    # record into a scratch directory, exit 1 on any difference
 *
 * It runs every suite that calls tests/helpers/adkReference.ts with
 * ADK_REFERENCE=record, so each case's ADK side runs exactly as the test runs
 * it (same scripted models, same stubs, the same virtual clock) and the test's
 * own assertions hold the native side to the value it writes. A suite name
 * after the flags records only the suites named (`-- nativeStep`), and leaves
 * the other suites' files alone, and so does a suite whose cases all skipped
 * (postgresStorage without TEST_DATABASE_URL). Run it twice and the files are the same
 * bytes: anything that differs per run is normalised (adkReference.ts's
 * canonical form, or the suite's own normalisation) before it is written.
 *
 * WS5-2b retires this script with ADK: the fixtures it wrote are then the
 * reference.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const TESTS = join(ROOT, 'tests');
const REFERENCE_DIR = join(TESTS, 'fixtures', 'adk-reference');

const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.filter((a) => !a.startsWith('--'));

/** Every suite that reads a reference: its file names the helper. */
function suites(): string[] {
  const all = readdirSync(TESTS)
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => readFileSync(join(TESTS, f), 'utf8').includes('helpers/adkReference.ts'))
    .sort();
  if (only.length === 0) return all;
  const picked = all.filter((f) => only.includes(f.replace(/\.test\.ts$/, '')));
  const unknown = only.filter((name) => !all.includes(`${name}.test.ts`));
  if (unknown.length) throw new Error(`not a suite that reads ADK references: ${unknown.join(', ')}`);
  return picked;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)))
    .sort();
}

/** The suite's directory under the reference root: tests/<name>.test.ts → <name> as adkReference slugs it. */
const suiteDirs = (files: string[]): string[] => files.map((f) => f.replace(/\.test\.ts$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));

function record(files: string[], dir: string): void {
  const run = spawnSync(
    process.execPath,
    ['--disable-warning=DEP0040', '--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--test', '--test-concurrency=1', '--test-reporter=dot', ...files.map((f) => join('tests', f))],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ADK_REFERENCE: 'record', ADK_REFERENCE_DIR: dir } },
  );
  if (run.status !== 0) {
    console.error('a suite failed while recording: its references are not trustworthy');
    process.exit(1);
  }
}

const files = suites();
if (files.length === 0) {
  console.error('no suite reads tests/helpers/adkReference.ts');
  process.exit(1);
}
const dirs = suiteDirs(files);

// Both modes record into a scratch directory first. A suite that records
// nothing had every case skipped (tests/postgresStorage.test.ts without
// TEST_DATABASE_URL): its files are left as they are and named, never
// deleted and never counted as drift.
const scratch = mkdtempSync(join(tmpdir(), 'adk-reference-'));
try {
  record(files, scratch);
  const skipped = dirs.filter((d) => filesUnder(join(scratch, d)).length === 0);
  for (const d of skipped) console.warn(`not recorded (its cases were skipped): tests/fixtures/adk-reference/${d} left as it is`);
  const recorded = dirs.filter((d) => !skipped.includes(d));
  if (!check) {
    let n = 0;
    for (const d of recorded) {
      rmSync(join(REFERENCE_DIR, d), { recursive: true, force: true });
      for (const f of filesUnder(join(scratch, d))) {
        mkdirSync(dirname(join(REFERENCE_DIR, d, f)), { recursive: true });
        copyFileSync(join(scratch, d, f), join(REFERENCE_DIR, d, f));
        n += 1;
      }
    }
    console.log(`recorded ${n} reference file(s) for ${recorded.length} suite(s)`);
  } else {
    let drift = 0;
    for (const d of recorded) {
      const want = filesUnder(join(scratch, d));
      const have = filesUnder(join(REFERENCE_DIR, d));
      for (const f of new Set([...want, ...have])) {
        const a = existsSync(join(scratch, d, f)) ? readFileSync(join(scratch, d, f), 'utf8') : undefined;
        const b = existsSync(join(REFERENCE_DIR, d, f)) ? readFileSync(join(REFERENCE_DIR, d, f), 'utf8') : undefined;
        if (a === b) continue;
        drift += 1;
        console.error(`${a === undefined ? 'stale (no longer recorded)' : b === undefined ? 'missing' : 'drift'}: tests/fixtures/adk-reference/${d}/${f}`);
      }
    }
    if (drift) {
      console.error(`${drift} ADK reference file(s) differ from what ADK does now: read the diff before re-recording.`);
      process.exit(1);
    }
    console.log(`ADK references are current (${recorded.length} suite(s) checked, ${skipped.length} skipped).`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
