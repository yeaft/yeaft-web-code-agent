import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

const root = new URL('../artifacts/showcase/', import.meta.url);
describe('work-anywhere presentation delivery', () => {
  it('contains exactly eight slides and notes with the agreed positioning', async () => {
    const zip = await JSZip.loadAsync(await readFile(new URL('yeaft-work-anywhere.pptx', root)));
    const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const notes = Object.keys(zip.files).filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(8);
    expect(notes).toHaveLength(8);
    const xml = (await Promise.all(slides.map(n => zip.file(n).async('string')))).join('\n');
    for (const phrase of ['Work from', 'anywhere.', 'Explicit handoffs', 'Workbench', 'Development automation', 'Work Center', 'Preview']) expect(xml.toLowerCase()).toContain(phrase.toLowerCase());
    expect(xml).not.toMatch(/from your phone|phone directs|tied to one machine/i);
    const narration = (await Promise.all(notes.map(n => zip.file(n).async('string')))).join('\n');
    expect(narration).toContain('110s');
    expect(narration).toContain('中文讲述提示');
    const rels = await zip.file('ppt/slides/_rels/slide8.xml.rels').async('string');
    expect(rels).toContain('https://github.com/yeaft/yeaft-web-code-agent#readme');
  });
  it('has a rendered eight-page report tied to the delivered PPTX', async () => {
    const { createHash } = await import('node:crypto');
    const deck = await readFile(new URL('yeaft-work-anywhere.pptx', root));
    const report = JSON.parse(await readFile(new URL('work-anywhere-render-report.json', root), 'utf8'));
    expect(report.input_sha256).toBe(createHash('sha256').update(deck).digest('hex'));
    expect([report.slide_count, report.pdf_pages, report.png_pages]).toEqual([8, 8, 8]);
  });
});
