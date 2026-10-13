import { describe, expect, it } from 'vitest';
import { LIMITS, validateProposal } from '../../../../agent/yeaft/person/contracts.js';

import { finalProposal } from './fixtures.js';
const validation = { stateVersion: 0, sourceRefs: new Set(['message:m:1']), concepts: new Map(), catalog: [{ id: 'test/first', efforts: ['low'] }] };

describe('digital Person strict contracts', () => {
  it('accepts only typed, sourced and versioned cognitive proposals', () => {
    expect(validateProposal(finalProposal(), validation).activity.kind).toBe('think');
    for (const mutate of [
      p => { p.workItemId = 'forbidden'; }, p => { p.baseStateVersion = 1; },
      p => { p.concepts[0].epistemicState = 'fact'; }, p => { p.concepts[0].sourceRefs = ['someone-elses-message']; },
      p => { p.concepts[0].associations = [{ targetId: 'unread', relation: 'related' }]; },
      p => { p.concepts[0].expectedRevision = 2; }, p => { p.concepts[0].kind = 'scenario'; },
      p => { p.concepts[0].epistemicState = 'reported'; }, p => { p.state.focusConceptIds.push('missing'); },
      p => { p.reply = 'x'.repeat(LIMITS.outputBytes + 1); }, p => { p.activity.hiddenReasoning = 'no'; },
    ]) {
      const proposal = finalProposal(); mutate(proposal);
      expect(() => validateProposal(proposal, validation)).toThrow();
    }
    const proposal = finalProposal();
    proposal.next = { model: 'external/unconfigured', effort: null, reason: 'switch', capability: null };
    expect(() => validateProposal(proposal, validation)).toThrow(/catalog/);
    proposal.next.model = 'test/first'; proposal.next.effort = 'ultra';
    expect(() => validateProposal(proposal, validation)).toThrow(/catalog/);
  });
});
