/**
 * tests/skillHarnessParity.test.ts — the skills harness on the engine's own
 * tool base (lib/tools/skills/, WS3-3, ADR 0083) shows a model what the
 * ADK-based harness showed it.
 *
 * tests/fixtures/skillHarness.adk.json was captured from the harness as it
 * stood on ADK's SkillToolset (ADK 2.2.0), before WS3-3 moved it: the skills
 * it loaded, the problems it reported, the instruction block, the tool
 * declarations in both scripts modes, the tools activation unlocked, and the
 * result of every call in a table of good and bad arguments, with each
 * approval answer. Here the engine's harness must give the same, key order
 * included (a stored event is JSON). Then ADK's own loader and validator
 * are held against the engine's: what ADK's returned for each shelf is
 * recorded (tests/fixtures/adk-reference/skillharnessparity) and read live
 * only under ADK_REFERENCE=live|record (tests/helpers/adkReference.ts).
 * Last, the parser's bounds are checked. Offline: no model is called.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { contractToolDeclaration } from '../lib/models/schemaNormalize.ts';
import { toFunctionTool } from '../lib/tools/adkTool.ts';
import { HarnessSkillToolset, loadSkillSuite, skillSuiteProblems, skillsInstruction } from '../lib/tools/skillToolset.ts';
import { MAX_FRONTMATTER_CHARS, MAX_SKILL_MD_CHARS, isSkillName, parseSkillMd, parseSkillMdContent, splitAllowedTools } from '../lib/tools/skills/frontmatter.ts';
import { SKILL_LIMITS, loadAllSkillsInDir, validateSkillDir } from '../lib/tools/skills/loader.ts';
import { ListSkillsTool } from '../lib/tools/skills/tools.ts';
import { createToolContext } from '../lib/tools/tool.ts';
import type { Tool } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { adkReferences, runsAdk } from './helpers/adkReference.ts';

const reference = adkReferences('skillHarnessParity');
if (runsAdk()) {
  const { LogLevel, setLogLevel } = await import('@google/adk');
  setLogLevel(LogLevel.ERROR);
}

const ROOT = process.cwd();
const DIRS: Record<string, string> = { fixtures: join(ROOT, 'tests/fixtures/skills'), parity: join(ROOT, 'tests/fixtures/skills-parity') };
const BEFORE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/skillHarness.adk.json'), 'utf-8'));

const lookup = defineTool({ name: 'harness_parity_lookup', description: 'Look up.', schema: z.object({ key: z.string() }), execute: async () => 'x' });
const other = defineTool({ name: 'harness_parity_other', description: 'Other.', schema: z.object({}), execute: async () => 'y' });

/** As the capture normalized: the output directory is minted per toolset, a Buffer is its base64. */
function norm(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (k, x) => {
      if (k === 'outputDirectory' && typeof x === 'string') return '<output-dir>';
      if (k === 'stderr' && typeof x === 'string' && x.includes('Cannot find module')) {
        // Node's stack names the run's temp directory: keep the error itself.
        const at = x.indexOf('Cannot find module');
        return x.slice(at, x.indexOf("'", x.indexOf("'", at) + 1) + 1);
      }
      if (x && typeof x === 'object' && (x as { type?: unknown }).type === 'Buffer') return { buffer: Buffer.from((x as { data: number[] }).data).toString('base64') };
      return x;
    }),
  );
}

const ARGS_TABLE: Record<string, Array<Record<string, unknown>>> = {
  load_skill: [{ name: 'kit' }, { name: ' kit ' }, { name: '' }, {}, { name: 'nope' }, { name: 'nested-one' }, { name: 'extra-field' }, { name: 7 }],
  load_skill_resource: [
    { skill_name: 'kit', path: 'references/a.md' },
    { skill_name: 'kit', path: 'references/sub/b.md' },
    { skill_name: 'kit', path: 'assets/template.yaml' },
    { skill_name: 'kit', path: 'assets/logo.png' },
    { skill_name: 'kit', path: 'scripts/hello.js' },
    { skill_name: 'kit', path: 'references/../references/a.md' },
    { skill_name: 'kit', path: './references/a.md' },
    { skill_name: 'kit', path: '../kit/SKILL.md' },
    { skill_name: 'kit', path: 'SKILL.md' },
    { skill_name: 'kit', path: 'references/missing.md' },
    { skill_name: 'kit', path: 'scripts/__pycache__/x.pyc' },
    { skill_name: 'kit' },
    { path: 'references/a.md' },
    { skill_name: 'nope', path: 'references/a.md' },
  ],
  run_skill_script: [
    { skill_name: 'kit', script_path: 'scripts/hello.js', args: { tag: 'beta', n: 2 } },
    { skill_name: 'kit', script_path: 'hello.js' },
    { skill_name: 'kit', script_path: 'scripts/fail.sh' },
    { skill_name: 'kit', script_path: 'scripts/writes.sh' },
    { skill_name: 'kit', script_path: 'scripts/notes.txt' },
    { skill_name: 'kit', script_path: 'scripts/missing.sh' },
    { skill_name: 'nope', script_path: 'scripts/hello.js' },
    { skill_name: 'kit' },
    { script_path: 'scripts/hello.js' },
  ],
};

const sorted = (xs: string[]) => [...xs].sort();

for (const [label, dir] of Object.entries(DIRS)) {
  const before = BEFORE.dirs[label];

  test(`${label}: the skills load to the objects ADK's loader made, key order included`, async () => {
    const skills = await loadSkillSuite(dir);
    assert.deepEqual(sorted(Object.keys(skills)), sorted(before.skillOrder));
    for (const [name, was] of Object.entries(before.skills as Record<string, any>)) {
      const skill = skills[name]!;
      assert.equal(JSON.stringify(skill.frontmatter), was.frontmatterJson, `${name}: the frontmatter, as load_skill returns it`);
      assert.equal(skill.instructions, was.instructions, `${name}: the body`);
      assert.deepEqual(norm(skill.resources), was.resources, `${name}: the files it ships`);
    }
    assert.deepEqual(sorted(await skillSuiteProblems(dir)), sorted(before.problems));
    assert.equal(skillsInstruction(skills, { dir }), before.instruction.none);
    assert.equal(skillsInstruction(skills, { dir, scripts: 'local' }), before.instruction.local);
  });

  for (const mode of ['none', 'local'] as const) {
    test(`${label} · scripts ${mode}: the declarations a model is sent are the ADK harness's, on both runtimes' paths`, async () => {
      const skills = await loadSkillSuite(dir);
      const toolset = new HarnessSkillToolset(skills, { dir, scripts: mode }, [lookup, other]);
      const tools = (await toolset.getTools()) as Tool[];
      // ADK's path: the FunctionTool the adapter builds declares in Gemini's dialect.
      assert.deepEqual(tools.map((t) => (toFunctionTool(t) as any)._getDeclaration()), before[mode].declarations);
      // Every other provider (and the native loop): the contract declaration, read from the Tool and from the old ADK declaration.
      for (const [i, tool] of tools.entries()) {
        const old = before[mode].declarations[i];
        assert.deepEqual(contractToolDeclaration(tool), contractToolDeclaration({ name: old.name, description: old.description, _getDeclaration: () => old }));
      }
    });

    test(`${label} · scripts ${mode}: loading activates a skill and unlocks the permitted tools it names, in ADK's order`, async () => {
      const skills = await loadSkillSuite(dir);
      if (!skills['nested-one'] || !skills.kit) return; // the fixtures dir has neither
      const toolset = new HarnessSkillToolset(skills, { dir, scripts: mode }, [lookup, other]);
      const load = ((await toolset.getTools()) as Tool[]).find((t) => t.name === 'load_skill')!;
      const state: Record<string, unknown> = {};
      for (const [i, name] of ['nested-one', 'kit'].entries()) {
        const ctx = createToolContext({ agentName: 'Harness', state });
        await load.execute({ name }, ctx);
        Object.assign(state, ctx.stateDelta);
        const listed = (await toolset.getTools({ agentName: 'Harness', state: { get: (k) => state[k] } })) as Array<{ name: string }>;
        assert.deepEqual(state, before[mode].activation[i].stateDelta);
        assert.deepEqual(listed.map((t) => t.name), before[mode].activation[i].tools);
      }
    });

    test(`${label} · scripts ${mode}: every call answers as the ADK harness answered, approval answers included`, async () => {
      const skills = await loadSkillSuite(dir);
      const toolset = new HarnessSkillToolset(skills, { dir, scripts: mode }, [lookup, other]);
      const got: Record<string, unknown[]> = {};
      for (const tool of (await toolset.getTools()) as Tool[]) {
        got[tool.name] = [];
        for (const args of ARGS_TABLE[tool.name] ?? []) {
          const variants = tool.name === 'run_skill_script' ? [undefined, { confirmed: false }, { confirmed: true }] : [undefined];
          for (const confirmation of variants) {
            const ctx = createToolContext({ agentName: 'Harness', invocationId: 'inv', ...(confirmation ? { confirmation } : {}) });
            const result = await tool.execute(structuredClone(args), ctx);
            got[tool.name]!.push(
              norm({
                args,
                confirmation: confirmation ?? null,
                result,
                requested: ctx.confirmationRequest ?? null,
                skipSummarization: ctx.actions.skipSummarization ?? null,
                stateDelta: ctx.stateDelta,
              }),
            );
          }
        }
      }
      const expected = norm(before[mode].calls) as Record<string, unknown[]>;
      for (const name of Object.keys(expected)) {
        for (const [i, call] of expected[name]!.entries()) assert.deepEqual(got[name]![i], call, `${name} call ${i}`);
        assert.equal(got[name]!.length, expected[name]!.length);
      }
      assert.deepEqual(Object.keys(got), Object.keys(expected));
    });
  }
}

test('list_skills writes the index as ADK\'s list_skills wrote it', async () => {
  const skills = await loadSkillSuite(DIRS.parity!);
  const list = new ListSkillsTool(new HarnessSkillToolset(skills, { dir: DIRS.parity! }));
  assert.deepEqual(list.declaration(), { name: 'list_skills', description: 'Lists all available skills with their names and descriptions.', parameters: { type: 'object', properties: {} } });
  const xml = (await list.execute()) as string;
  assert.match(xml, /^<available_skills>\n {2}<skill>/);
  assert.match(xml, /<description>A kit of every resource kind, for the harness parity suite: &lt;tags&gt; &amp; &quot;quotes&quot;\.<\/description>/);
  assert.equal(await new ListSkillsTool(new HarnessSkillToolset({}, { dir: 'x' })).execute(), '<available_skills>\n</available_skills>');
});

// ── Live against ADK's loader ────────────────────────────────────────────────

function edgeShelf(): string {
  const base = mkdtempSync(join(tmpdir(), 'ws3-3-skills-'));
  const write = (name: string, text: string) => {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, 'SKILL.md'), text);
  };
  write('quoted', `---\nname: "quoted"\ndescription: 'Single: quoted, with a colon.'\nlicense: Apache-2.0\ncompatibility: node >= 22\n---\nBody.\n`);
  write('folded', `---\nname: folded\ndescription: >\n  A folded\n  description.\nallowed-tools: a b,c  ,d\nextra: [1, 2]\n---\n\n  Body with --- inside.\n`);
  write('camel', `---\nname: camel\ndescription: Both spellings.\nallowedTools: x y\nallowed-tools: z\nmetadata: { k: 1 }\n---\nB`);
  write('snake_case_ok', `---\nname: snake_case_ok\ndescription: Snake.\n---\n`);
  write('empty-body', `---\nname: empty-body\ndescription: Nothing after.\n---`);
  write('UPPER', `---\nname: UPPER\ndescription: Bad name.\n---\nx`);
  write('mixed-delim_x', `---\nname: mixed-delim_x\ndescription: Bad name.\n---\nx`);
  write('no-desc', `---\nname: no-desc\n---\nx`);
  write('long-desc', `---\nname: long-desc\ndescription: ${'d'.repeat(1025)}\n---\nx`);
  write('bad-meta', `---\nname: bad-meta\ndescription: d\nmetadata:\n  adk_additional_tools: nope\n---\nx`);
  write('list-fm', `---\n- a\n- b\n---\nx`);
  write('unclosed', `---\nname: unclosed\ndescription: d\n`);
  write('bad-yaml', `---\nname: bad-yaml\ndescription: [unclosed\n---\nx`);
  write('num-name', `---\nname: 123\ndescription: d\n---\nx`);
  return base;
}

/** The shelves read against ADK, by a stable name: the two fixture shelves and the edge-case one (a fresh temp dir per run). */
const shelvesWith = (edge: string): Array<[string, string]> => [['parity', DIRS.parity!], ['fixtures', DIRS.fixtures!], ['edge', edge]];

/** A problem's text with the shelf's own path out: the edge shelf is a temp dir minted per run. */
const onShelf = (problem: string, shelf: string): string => problem.split(shelf).join('<shelf>');

test('ADK\'s loader and the engine\'s load the same skills to the same JSON from an edge-case shelf', async () => {
  const base = edgeShelf();
  try {
    for (const [label, shelf] of shelvesWith(base)) {
      // ADK's loader: each skill it loaded, as normalized JSON (key order included).
      const adk = await reference(`loader-${label}`, async () => {
        const skills = (await (await import('@google/adk')).loadAllSkillsInDir(shelf)) as Record<string, unknown>;
        return Object.fromEntries(Object.entries(skills).map(([name, skill]) => [name, JSON.stringify(norm(skill))]));
      });
      const own = await loadAllSkillsInDir(shelf);
      assert.deepEqual(sorted(Object.keys(own)), sorted(Object.keys(adk)), `${shelf}: the same skills load`);
      for (const name of Object.keys(adk)) assert.equal(JSON.stringify(norm(own[name])), adk[name], `${shelf} · ${name}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('validateSkillDir finds a problem exactly where ADK\'s does, with ADK\'s words for the structural ones', async () => {
  const base = edgeShelf();
  const dirsOf = (shelf: string) => readdirSync(shelf, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'group').map((e) => e.name).sort();
  try {
    for (const [label, shelf] of shelvesWith(base).filter(([l]) => l !== 'fixtures')) {
      // ADK's validator: the problems it found in each skill directory, the shelf's path out.
      const problems = await reference(`validate-${label}`, async () => {
        const { validateSkillDir: adkValidateSkillDir } = await import('@google/adk');
        const out: Record<string, string[]> = {};
        for (const name of dirsOf(shelf)) out[name] = (await adkValidateSkillDir(join(shelf, name))).map((p) => onShelf(p, shelf));
        return out;
      });
      assert.deepEqual(Object.keys(problems), dirsOf(shelf), `${label}: ADK read every skill directory`);
      for (const name of dirsOf(shelf)) {
        const adk = problems[name]!;
        const own = (await validateSkillDir(join(shelf, name))).map((p) => onShelf(p, shelf));
        assert.equal(own.length > 0, adk.length > 0, `${name}: a problem on both or neither`);
        // A field ADK's zod schema refuses, or YAML its js-yaml cannot parse, is reported in the engine's own
        // words (ADR 0083); every other text is ADK's.
        const ownWords = (p: string) => p.startsWith('Invalid YAML in frontmatter:') && !p.endsWith('must be a YAML mapping');
        if (!adk.some(ownWords)) {
          assert.deepEqual(own.map((p) => p.split('\n')[0]), adk.map((p) => p.split('\n')[0]), name);
        }
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── The parser's bounds ──────────────────────────────────────────────────────

test('the parser refuses oversized input before parsing, and nothing in it backtracks on hostile text', () => {
  assert.throws(() => parseSkillMd(`---\nname: a\n---\n${'x'.repeat(MAX_SKILL_MD_CHARS)}`), /larger than/);
  assert.throws(() => parseSkillMd(`---\n# ${'x'.repeat(MAX_FRONTMATTER_CHARS)}\n---\nbody`), /frontmatter is larger than/);
  const started = performance.now();
  assert.throws(() => parseSkillMd(`---${' '.repeat(MAX_FRONTMATTER_CHARS - 10)}`), /not properly closed/);
  assert.equal(isSkillName(`${'a-'.repeat(200_000)}`), false);
  assert.equal(isSkillName(`${'a_'.repeat(200_000)}a`), true);
  assert.deepEqual(splitAllowedTools(`${' ,'.repeat(200_000)}x`), ['x']);
  assert.ok(performance.now() - started < 2000, 'linear in the input');
});

test('the name rule matches ADK\'s pattern on a table of names', () => {
  const adk = /^([a-z0-9]+(-[a-z0-9]+)*|[a-z0-9]+(_[a-z0-9]+)*)$/;
  for (const name of ['a', 'a1', 'a-b', 'a_b', 'a-b-c', 'a_b_c', '-a', 'a-', '_a', 'a_', 'a--b', 'a__b', 'a-b_c', 'A', 'a b', 'a.b', '', 'ä', '1-2', 'a-1_2']) {
    assert.equal(isSkillName(name), adk.test(name), name);
  }
});

test('a frontmatter key named __proto__ is data, never a prototype', () => {
  const { frontmatter } = parseSkillMdContent('---\nname: p\ndescription: d\n__proto__:\n  polluted: true\nmetadata:\n  __proto__:\n    polluted: true\n---\nx');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(frontmatter), Object.prototype);
  assert.equal(Object.getPrototypeOf(frontmatter.metadata), Object.prototype);
});

test('a resource over the size limit is skipped and reported, not read', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ws3-3-big-'));
  try {
    mkdirSync(join(base, 'big', 'references'), { recursive: true });
    writeFileSync(join(base, 'big', 'SKILL.md'), '---\nname: big\ndescription: Ships one huge file.\n---\nx');
    writeFileSync(join(base, 'big', 'references', 'small.md'), 'small');
    writeFileSync(join(base, 'big', 'references', 'huge.bin'), Buffer.alloc(SKILL_LIMITS.resourceBytes + 1));
    const warnings: string[] = [];
    const skills = await loadAllSkillsInDir(base, { onWarning: (m) => warnings.push(m) });
    assert.deepEqual(Object.keys(skills.big!.resources.references), ['small.md']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /huge\.bin': larger than/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a model cannot reach a prototype key as a skill or a file', async () => {
  const skills = await loadSkillSuite(DIRS.parity!);
  const toolset = new HarnessSkillToolset(skills, { dir: DIRS.parity!, scripts: 'local' });
  const [load, resource, run] = (await toolset.getTools()) as Tool[];
  const ctx = () => createToolContext({ agentName: 'Harness' });
  assert.deepEqual(await load!.execute({ name: 'constructor' }, ctx()), { error: "Skill 'constructor' not found. Installed: extra-field, kit, nested-one.", error_code: 'SKILL_NOT_FOUND' });
  assert.deepEqual(await resource!.execute({ skill_name: 'kit', path: 'references/constructor' }, ctx()), {
    error: "Resource 'references/constructor' not found in skill 'kit'.",
    error_code: 'RESOURCE_NOT_FOUND',
  });
  const approved = createToolContext({ agentName: 'Harness', confirmation: { confirmed: true } });
  assert.deepEqual(await run!.execute({ skill_name: 'kit', script_path: 'scripts/__proto__' }, approved), { error: "Script 'scripts/__proto__' not found in skill 'kit'.", errorCode: 'SCRIPT_NOT_FOUND' });
});
