import type { VariantId } from '../types';
import type { GameVariant } from './types';
import { holdem } from './holdem';

/**
 * The playable games. A VariantId may exist in the type union before its
 * module ships — config normalization filters enabledVariants to this
 * registry, so an unimplemented id can never reach a live game.
 */
const VARIANTS: Partial<Record<VariantId, GameVariant>> = {
  holdem,
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
 * TEST-ONLY: register a stub variant so engine tests can exercise
 * multi-variant flows before more games ship. Returns an unregister fn.
 */
export function _registerVariantForTest(v: GameVariant): () => void {
  VARIANTS[v.id] = v;
  if (!IMPLEMENTED_VARIANTS.includes(v.id)) IMPLEMENTED_VARIANTS.push(v.id);
  return () => {
    delete VARIANTS[v.id];
    const i = IMPLEMENTED_VARIANTS.indexOf(v.id);
    if (i >= 0) IMPLEMENTED_VARIANTS.splice(i, 1);
  };
}
