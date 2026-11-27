import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renders, svgOutputs, variants } from '../../scripts/generate-brand-icons.mjs';
import { applyDocumentTheme, setThemeColorSurface } from '../../web/utils/document-theme.js';

const repoRoot = resolve(process.cwd());
const webDir = join(repoRoot, 'web');
const brandDir = join(webDir, 'assets', 'brand');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

/** Width / height from a PNG IHDR chunk. */
function pngSize(file) {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('latin1'), `${file} is not a PNG`).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function bgMainTokens() {
  const css = read('web', 'styles', 'variables.css');
  const darkAt = css.indexOf('[data-theme="dark"]');
  const pick = (chunk) => chunk.match(/--bg-main:\s*(#[0-9a-fA-F]{3,8})\s*;/)?.[1]?.toLowerCase();
  return { light: pick(css.slice(0, darkAt)), dark: pick(css.slice(darkAt)) };
}

/** Brand-related head lines, with build-time hashes stripped back to source paths. */
function brandHeadLines(html) {
  return html.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /rel="(icon|apple-touch-icon|manifest)"|name="(theme-color|application-name|apple-mobile-web-app-title)"/.test(line))
    .map(line => line
      .replace(/\$\{brandIcon\('([^']+)'\)\}/g, 'assets/brand/$1')
      .replace('manifest.webmanifest?v=${manifestHash}', 'manifest.webmanifest'));
}

describe('brand app icons', () => {
  it('keeps committed SVG artwork in sync with the generator', () => {
    for (const { variant, path } of svgOutputs) {
      expect(existsSync(path), `missing ${path}`).toBe(true);
      expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), `${path} drifted; run npm run brand-icons`).toBe(variants[variant]);
    }
  });

  it('ships every PNG render at its declared size', () => {
    for (const { file, size } of renders) {
      expect(pngSize(join(brandDir, file)), file).toEqual({ width: size, height: size });
    }
  });

  it('declares an installable manifest whose icons exist at their declared sizes', () => {
    const manifest = JSON.parse(read('web', 'manifest.webmanifest'));
    const tokens = bgMainTokens();
    expect(manifest).toMatchObject({
      name: 'Yeaft',
      short_name: 'Yeaft',
      start_url: './',
      scope: './',
      display: 'standalone',
      theme_color: tokens.light,
      background_color: tokens.light,
    });
    const has = (purpose, sizes) => manifest.icons.some(icon => icon.purpose === purpose && icon.sizes === sizes);
    expect(has('any', '192x192') && has('any', '512x512') && has('maskable', '512x512')).toBe(true);
    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(icon.type).toBe('image/png');
      expect(pngSize(join(webDir, icon.src)), icon.src).toEqual({ width, height });
    }
  });

  it('links the same icons, manifest and theme colors in dev and production HTML', () => {
    const devHead = brandHeadLines(read('web', 'index.html'));
    const prodHead = brandHeadLines(read('web', 'build.js'));
    const tokens = bgMainTokens();
    expect(devHead).toEqual(prodHead);
    expect(devHead).toEqual([
      '<link rel="icon" href="assets/brand/favicon-32.png" sizes="32x32" type="image/png">',
      '<link rel="icon" href="assets/brand/favicon.svg" type="image/svg+xml">',
      '<link rel="apple-touch-icon" href="assets/brand/apple-touch-icon.png">',
      '<link rel="manifest" href="manifest.webmanifest">',
      '<meta name="application-name" content="Yeaft">',
      '<meta name="apple-mobile-web-app-title" content="Yeaft">',
      `<meta name="theme-color" content="${tokens.light}" media="(prefers-color-scheme: light)">`,
      `<meta name="theme-color" content="${tokens.dark}" media="(prefers-color-scheme: dark)">`,
    ]);
    expect(read('web', 'build.js')).toContain("writeFileSync(join(distDir, 'manifest.webmanifest')");
    // The welcome-screen logo is cache-busted through a build-time define.
    expect(read('web', 'build.js')).toContain("BRAND_ICON_URL: JSON.stringify(brandIcon('icon.svg'))");
    const messageList = read('web', 'components', 'MessageList.js');
    expect(messageList).toContain("typeof BRAND_ICON_URL === 'undefined' ? 'assets/brand/icon.svg' : BRAND_ICON_URL");
    expect(messageList).toContain('<img :src="welcomeLogoUrl"');
    expect(read('Dockerfile')).toMatch(/COPY web\/\*\.js web\/\*\.css web\/\*\.html web\/\*\.webmanifest \.\//);
  });

  it('applies the theme to the document and syncs theme-color metas from --bg-main', () => {
    const attrs = {};
    const toggle = vi.fn();
    const metas = [{ setAttribute: vi.fn() }, { setAttribute: vi.fn() }];
    const root = { setAttribute: (k, v) => { attrs[k] = v; }, classList: { toggle } };
    const doc = {
      documentElement: root,
      defaultView: { getComputedStyle: () => ({ getPropertyValue: name => (name === '--bg-main' ? ' #1a1a1a ' : '') }) },
      querySelectorAll: () => metas,
    };

    applyDocumentTheme('dark', doc);

    expect(attrs['data-theme']).toBe('dark');
    expect(toggle).toHaveBeenCalledWith('light', false);
    for (const meta of metas) expect(meta.setAttribute).toHaveBeenCalledWith('content', '#1a1a1a');

    const bare = { documentElement: { setAttribute: vi.fn(), classList: { toggle: vi.fn() } }, defaultView: null };
    expect(() => applyDocumentTheme('light', bare)).not.toThrow();
    expect(bare.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(() => applyDocumentTheme('light', undefined)).not.toThrow();
  });

  it('lets a full-bleed surface own theme-color until it is cleared', () => {
    let bgMain = '#fafaf8';
    const meta = { content: '', setAttribute(_k, v) { this.content = v; } };
    const doc = {
      documentElement: { setAttribute() {}, classList: { toggle() {} } },
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => bgMain }) },
      querySelectorAll: () => [meta],
    };
    try {
      setThemeColorSurface(' #02040a ', doc);
      expect(meta.content).toBe('#02040a');
      bgMain = '#1a1a1a';
      applyDocumentTheme('dark', doc);
      expect(meta.content, 'theme switches under the surface keep the surface color').toBe('#02040a');
      setThemeColorSurface(null, doc);
      expect(meta.content).toBe('#1a1a1a');
    } finally {
      setThemeColorSurface(null, doc);
    }
    const cosmosPage = read('web', 'components', 'cosmos', 'CosmosPage.js');
    expect(cosmosPage).toContain("setThemeColorSurface(window.getComputedStyle(pageEl).getPropertyValue('--c-bg'))");
    expect(cosmosPage).toContain('setThemeColorSurface(null);');
  });
});
