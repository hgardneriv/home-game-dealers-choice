import type { VariantId } from '../types';
import type { GameVariant } from './types';
import { holdem } from './holdem';
import { fiveDraw } from './five-draw';
import { sevenStud } from './seven-stud';
import { guts } from './guts';
import { baseball } from './baseball';
import { inBetween } from './in-between';

/**
 * The playable games. A VariantId may exist in the type union before its
 * module ships — config normalization filters enabledVariants to this
 * registry, so an unimplemented id can never reach a live game.
 */
const VARIANTS: Partial<Record<VariantId, GameVariant>> = {
  holdem,
  'five-draw': fiveDraw,
  'seven-stud': sevenStud,
  guts,
  baseball,
  'in-between': inBetween,
};

export const IMPLEMENTED_VARIANTS = Object.keys(VARIANTS) as VariantId[];

export function getVariant(id: VariantId): GameVariant {
  const v = VARIANTS[id];
  if (!v) throw new Error(`Variant not implemented: ${id}`);
  return v;
}

export function isImplemented(id: string): id is VariantId {
  return id in VARIANTS;
}

/**
 * TEST-ONLY: register a stub variant (possibly shadowing a real module under
 * the same id). Returns an unregister fn that restores what was there before.
 */
export function _registerVariantForTest(v: GameVariant): () => void {
  const previous = VARIANTS[v.id];
  const wasListed = IMPLEMENTED_VARIANTS.includes(v.id);
  VARIANTS[v.id] = v;
  if (!wasListed) IMPLEMENTED_VARIANTS.push(v.id);
  return () => {
    if (previous) {
      VARIANTS[v.id] = previous;
    } else {
      delete VARIANTS[v.id];
      const i = IMPLEMENTED_VARIANTS.indexOf(v.id);
      if (i >= 0) IMPLEMENTED_VARIANTS.splice(i, 1);
    }
  };
}
