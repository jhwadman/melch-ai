/**
 * lib/guards/index.ts — post-answer guards, resolved by NAME from a syndicate's
 * `guards:` list the way tools are resolved from `tools:`.
 *
 * A guard runs after the answering turn and before the reply ships
 * (lib/runtime/syndicateTurn.ts — the server, REPL, worker and evals alike). It receives the final text and every tool-result
 * text that turn produced, and returns the text to ship plus notes for the
 * `[STATUS]` stream. It never re-asks a model: at temperature 0 the same
 * prompt returns the same sentence, so a guard that fires annotates in place.
 *
 * Names, not module paths: a YAML that could name an arbitrary file to load
 * is a code-loading vector. Adding a guard is a deliberate act here.
 *
 * It ships the guard interface and two guards: `science`
 * (lib/guards/science.ts), which research.yaml runs — identifier closure, a
 * retraction check, and name correspondence over the answer — and `augustin`
 * (lib/guards/augustin.ts), which the fact-checking desk runs — the verdict
 * vocabulary, headline and limit line computed from the researcher's verdicts
 * block, cited domains held to the record. Any other guard a syndicate names
 * gets the ordinary "Unknown guard — ignored" warning. Register your own by
 * adding it to GUARD_MAP.
 */

import { IdLedger, runGuards } from './science.ts';
import { applyGuard as applyAugustin } from './augustin.ts';

// The pure functions, re-exported so a consumer importing `./guards` can
// unit-test the rules or mirror them in a front end without the runtime.
export {
  applyGuard as applyAugustinGuard,
  computeHeadline as computeAugustinHeadline,
  computeWord as computeAugustinWord,
  parseVerdicts as parseAugustinVerdicts,
  canonicalWord as canonicalAugustinWord,
  VERDICT_WORDS as AUGUSTIN_VERDICT_WORDS,
} from './augustin.ts';
export type { ClaimKind, ComputedWord, Verdict, VerdictWord, VerdictsBlock } from './augustin.ts';

export interface GuardResult {
  text: string;
  notes: string[];
}

export interface Guard {
  name: string;
  run(text: string, toolResultTexts: string[]): Promise<GuardResult>;
}

const scienceGuard: Guard = {
  name: 'science',
  async run(text, toolResultTexts) {
    const ledger = new IdLedger();
    for (const t of toolResultTexts) ledger.noteFromToolText(t);
    const report = await runGuards(text, ledger);
    // runGuards annotates the answer and NOTES any work whose retraction lookup
    // could not be completed, so a failed lookup never reads as a clean bill.
    return { text: report.answer, notes: report.notes };
  },
};

const augustinGuard: Guard = {
  name: 'augustin',
  async run(text, toolResultTexts) {
    // Pure and synchronous; applyGuard never throws — malformed input ships
    // the text unchanged with a note, so a broken record never blanks a reply.
    return applyAugustin(text, toolResultTexts);
  },
};

// Null-prototype so a name like `toString` cannot resolve off Object.prototype
// and skip the unknown-guard warning.
const GUARD_MAP: Record<string, Guard> = Object.assign(Object.create(null), {
  science: scienceGuard,
  augustin: augustinGuard,
});

export function resolveGuards(names: string[] = [], onUnknown?: (name: string) => void): Guard[] {
  return names
    .map((name) => {
      const guard = Object.prototype.hasOwnProperty.call(GUARD_MAP, name)
        ? GUARD_MAP[name]
        : undefined;
      if (!guard) { onUnknown?.(name); return null; }
      return guard;
    })
    .filter((g): g is Guard => g !== null);
}

/**
 * Make a guard resolvable by name from a syndicate's `guards:` list — for
 * package consumers, the same deliberate act as adding it to GUARD_MAP
 * above, done in their own code. Replacing a built-in requires
 * `{ override: true }`.
 */
export function registerGuard(guard: Guard, options: { override?: boolean } = {}): void {
  if (!guard || typeof guard.run !== 'function' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(guard.name ?? '')) {
    throw new Error('registerGuard: a guard needs a valid name and a run(text, toolResultTexts) function');
  }
  if (Object.prototype.hasOwnProperty.call(GUARD_MAP, guard.name) && !options.override) {
    throw new Error(`registerGuard: '${guard.name}' is already registered (pass { override: true } to replace it)`);
  }
  GUARD_MAP[guard.name] = guard;
}
