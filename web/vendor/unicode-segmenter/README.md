# unicode-segmenter

Browser fallback for Unicode grapheme boundaries when `Intl.Segmenter` is unavailable. The vendored ES module contains only the grapheme entry point and its bundled Unicode tables from [`unicode-segmenter@0.17.3`](https://github.com/cometkim/unicode-segmenter), licensed under the MIT license in `LICENSE`.

To regenerate, unpack the npm tarball for this exact version and run the project's `esbuild`:

```sh
npm pack unicode-segmenter@0.17.3
mkdir unicode-segmenter-source
tar -xzf unicode-segmenter-0.17.3.tgz -C unicode-segmenter-source
node_modules/.bin/esbuild unicode-segmenter-source/package/grapheme.js --bundle --minify --target=es2020 --format=esm --banner:js='/*! unicode-segmenter 0.17.3 | Copyright (c) 2024 Hyeseong Kim | MIT | See LICENSE */' --outfile=web/vendor/unicode-segmenter/grapheme.js
```
