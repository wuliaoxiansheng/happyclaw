import { describe, expect, it } from 'vitest';

import type { ToolResultFacts as WireFacts } from '../src/stream-event.types.js';
import type { ToolResultFacts as StepFacts } from '../src/stream-steps.js';

/**
 * ToolResultFacts is declared in shared/stream-event.ts (the wire) and in
 * shared/stream-steps.ts (the step reducer): the latter cannot import the
 * former, because it is copied to places with different import paths. These
 * assignments fail to compile if the two declarations drift apart.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Equal<WireFacts, StepFacts> = true;

describe('ToolResultFacts', () => {
  it('is the same shape on the wire and in the steps', () => {
    expect(sameShape).toBe(true);
    const facts: WireFacts = { added: 1, agent: { reads: 2 } };
    const asStep: StepFacts = facts;
    expect(asStep).toEqual(facts);
  });
});
