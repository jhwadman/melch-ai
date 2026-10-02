/**
 * tests/registryBundle.test.ts — a registry version is one unit (ADR 0018
 * item 6): publishing stores every nested yaml_reference with the syndicate,
 * and a bundled definition loads its nested syndicates from that bundle, not
 * from files that may have changed since.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bundleReferences, collectGuards, loadSyndicate, nestedLoader } from '../lib/loadSyndicate.ts';
import { configDigest } from '../lib/observability/lineage.ts';
import { publishAgent, type RegistryClient } from '../lib/registry.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';

const dir = mkdtempSync(join(tmpdir(), 'melch-bundle-'));
const write = (name: string, lines: string[]) => writeFileSync(join(dir, name), lines.join('\n'));
write('parent.yaml', [
  'syndicate_name: Parent',
  'variables: { who: parent }',
  'orchestrator: { name: Lead, model: gemini-3.8-flash, instruction: "I am {{who}}." }',
  'subagents:',
  '  - { name: Mid, description: Middle., yaml_reference: mid.yaml }',
  '  - { name: Leaf2, description: Leaf again., yaml_reference: leaf.yaml }',
]);
write('mid.yaml', [
  'syndicate_name: Mid',
  'orchestrator: { name: MidLead, model: gemini-3.8-flash, instruction: Middle. }',
  'subagents:',
  '  - { name: Leaf, description: Leaf., yaml_reference: leaf.yaml }',
]);
write('leaf.yaml', [
  'syndicate_name: Leaf',
  'variables: { who: leaf }',
  'guards: [science]',
  'orchestrator: { name: LeafLead, model: gemini-3.8-flash, instruction: "I am {{who}}." }',
  'subagents: []',
]);

const fake = (): RegistryClient & { published: unknown[] } => {
  const published: unknown[] = [];
  return {
    published,
    rpc: async (_fn, args) => (published.push(args.p_config), { data: 1, error: null }),
    from: () => ({}),
  };
};

test('bundleReferences reads every nested reference once, raw, transitively', () => {
  const parent = loadSyndicate('parent.yaml', { agentsDir: dir });
  const bundle = bundleReferences(parent, { agentsDir: dir })!;
  assert.deepEqual(Object.keys(bundle).sort(), ['leaf.yaml', 'mid.yaml']);
  // raw: the nested syndicate's own {{tokens}} are kept for its own variables
  assert.match((bundle['leaf.yaml']!.orchestrator as any).instruction, /\{\{who\}\}/);
  assert.equal(bundleReferences({ syndicate_name: 'x', subagents: [] }), undefined);
});

test('a bad nested file fails the bundle (the publish), not the first request', () => {
  write('broken.yaml', ['syndicate_name: Broken', 'orchestrator: { name: B, model: m }']);
  assert.throws(() => bundleReferences({ subagents: [{ name: 'X', yaml_reference: 'broken.yaml' }] }, { agentsDir: dir }), /broken\.yaml/);
});

test('publishAgent stores the bundle; --no-bundle and a pre-bundled config are stored as given', async () => {
  const raw = { ...loadSyndicate('parent.yaml', { agentsDir: dir }) };
  const c = fake();
  await publishAgent(c, 'parent', raw, { agentsDir: dir });
  const stored = c.published[0] as any;
  assert.deepEqual(Object.keys(stored.bundled_references).sort(), ['leaf.yaml', 'mid.yaml']);
  validateSyndicateConfig(structuredClone(stored), 'stored'); // the server accepts what was stored

  await publishAgent(c, 'parent', raw, { agentsDir: dir, bundle: false });
  assert.equal((c.published[1] as any).bundled_references, undefined);

  await publishAgent(c, 'parent', stored, { agentsDir: '/nonexistent' });
  assert.deepEqual(c.published[2], stored, 'already bundled: not re-read');
});

test('a bundled definition loads nested syndicates from the bundle, not the files', async () => {
  const c = fake();
  await publishAgent(c, 'parent', loadSyndicate('parent.yaml', { agentsDir: dir }), { agentsDir: dir });
  // The files change after publishing; the published version must not.
  write('leaf.yaml', [
    'syndicate_name: Leaf',
    'orchestrator: { name: LeafLead, model: gemini-3.8-flash, instruction: CHANGED }',
    'subagents: []',
  ]);
  const before = process.env.MELCHIZEDEK_AGENTS_DIR;
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  try {
    const stored = validateSyndicateConfig(structuredClone(c.published[0]), 'registry:parent') as any;
    const load = nestedLoader(stored);
    const leaf = load('leaf.yaml');
    assert.equal(leaf.orchestrator.instruction, 'I am leaf.', 'bundled, and interpolated with its own variables');
    assert.deepEqual(collectGuards(stored), ['science'], 'guards of bundled syndicates are found');
    assert.throws(() => load('other.yaml'), /not in this definition's bundle/);
    // without a bundle: files, as before
    assert.equal(nestedLoader({ ...stored, bundled_references: undefined })('leaf.yaml').orchestrator.instruction, 'CHANGED');
    // the lineage hash covers the bundled version
    assert.notEqual(configDigest(stored, load), configDigest(stored, (r) => loadSyndicate(r)));
  } finally {
    if (before === undefined) delete process.env.MELCHIZEDEK_AGENTS_DIR;
    else process.env.MELCHIZEDEK_AGENTS_DIR = before;
  }
});
