import { access } from 'node:fs/promises';

// Test-only vectors. Production never substitutes this for the pinned CPU model.
export function createEmbedding(options) {
  return {
    async embed(texts) {
      if (options.failFile) {
        const exists = await access(options.failFile).then(() => true, () => false);
        if (exists) throw new Error('test model unavailable');
      }
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      return texts.map(text => {
        const result = new Array(384).fill(0);
        result[/car|automobile|servicing|repair/i.test(text) ? 0 : /orange|fruit/i.test(text) ? 1 : 2] = 1;
        return result;
      });
    },
    async close() {},
  };
}
