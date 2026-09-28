export const config = {
  providers: [{ name: 'test', models: ['first', 'second'] }], primaryModel: 'test/first',
  availableModels: [
    { id: 'first', ref: 'test/first', contextWindow: 100000, maxOutput: 4096, effortOptions: ['low', 'high'] },
    { id: 'second', ref: 'test/second', contextWindow: 100000, maxOutput: 4096, effortOptions: ['low', 'high'] },
  ],
};
export const finalProposal = (version = 0) => ({
  baseStateVersion: version, activity: { kind: 'think', summary: 'Reconsider the available experience.', sourceRefs: [] },
  decision: { summary: 'Keep an unresolved question.', uncertainties: ['No independent evidence yet.'], selfCheck: 'A hypothesis is not a fact.' },
  concepts: [{ id: 'curiosity', expectedRevision: 0, kind: 'question', statement: 'What would change my understanding?', epistemicState: 'uncertain', sourceRefs: [], associations: [] }],
  state: { summary: 'Curious and undecided.', focusConceptIds: ['curiosity'], appraisal: 'curious' }, reply: 'I will keep that in mind.', next: null,
});
