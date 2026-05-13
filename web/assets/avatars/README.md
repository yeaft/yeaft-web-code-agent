# Avatar assets

13 pre-generated SVG portraits served as static assets at
`/assets/avatars/<id>.svg`:

- `ada.svg`, `alan.svg`, `alice.svg`, `dieter.svg`, `grace.svg`,
  `ken.svg`, `linus.svg`, `margaret.svg`, `martin.svg`, `norman.svg`,
  `shannon.svg`, `steve.svg` — one per VP in the default roster
  (must match `KNOWN_AVATAR_IDS` in `web/components/VpAvatar.js`).
- `user.svg` — the single human-side avatar used by `UserAvatar.js`.

## Regeneration

```bash
npm run avatars
```

This runs `scripts/generate-avatars.mjs`, which calls DiceBear's
`createAvatar()` with the `personas` style and the same seeds each time.
Output is deterministic — committing the SVGs is intentional so the
production bundle has zero runtime dependency on DiceBear and works
fully offline.

If you add a new VP, append its id to the `ENTRIES` array in the
generator script AND to the `KNOWN_AVATAR_IDS` set in `VpAvatar.js`,
then run the script.

## License

Avatar style: **Personas by Draftbit** (https://personas.draftbit.com/),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Each generated SVG embeds the attribution as RDF metadata in the file
itself — see any `*.svg` for the full provenance string.

DiceBear core library is MIT-licensed
(https://github.com/dicebear/dicebear).
