## Inter

`Inter[opsz,wght].ttf` and `Inter-Italic[opsz,wght].ttf` are the variable
fonts (optical size + weight axes, weight 100–900) from the Google Fonts
repository at https://github.com/google/fonts/tree/main/ofl/inter.

Inter is the app's `font-sans` and `font-display` typeface. It is
self-hosted so the desktop app has no runtime font dependency and renders
identically offline. The optical size axis automatically tracks body sizes
comfortably and display sizes tighter, so component code should not add
letter-spacing compensation. (Inter Tight was evaluated and rejected: it is
a frozen display-oriented fork that is too tight for body copy.)

Licensed under the SIL Open Font License 1.1 — see `INTER_OFL.txt`.

## Fraunces

`Fraunces[SOFT,WONK,opsz,wght].ttf` and
`Fraunces-Italic[SOFT,WONK,opsz,wght].ttf` are the variable fonts from the
Google Fonts repository at https://github.com/google/fonts/tree/main/ofl/fraunces.

Fraunces is an expressive serif option for Home canvas labels. It is
self-hosted so saved labels render consistently offline.

Licensed under the SIL Open Font License 1.1 — see `FRAUNCES_OFL.txt`.

## Comic Relief

`ComicRelief-Regular.ttf` and `ComicRelief-Bold.ttf` come from the Google Fonts
repository at https://github.com/google/fonts/tree/main/ofl/comicrelief.
Comic Relief is a free, metrically compatible alternative to Comic Sans MS for
nostalgic Home canvas labels.

Licensed under the SIL Open Font License 1.1 — see `COMIC_RELIEF_OFL.txt`.

## Permanent Marker

`PermanentMarker-Regular.ttf` comes from the Google Fonts repository at
https://github.com/google/fonts/tree/main/apache/permanentmarker. It provides a
bold handwritten option for Home canvas labels.

Licensed under the Apache License 2.0 — see `PERMANENT_MARKER_LICENSE.txt`.

## Geist Mono

`GeistMono[wght].ttf` is the variable font (weight axis 100–900) from the
Google Fonts repository at
https://github.com/google/fonts/tree/main/ofl/geistmono.

Geist Mono backs the `--font-mono` token (code, paths, terminal output) and
the digital clock face. Upstream ships no italic.

Licensed under the SIL Open Font License 1.1 — see `GEIST_MONO_OFL.txt`.

## Nerd Fonts Symbols

`nerd-font-symbols.woff2` is the symbols-only Nerd Fonts webfont from
https://www.nerdfonts.com/assets/css/webfont.css, version 3.4.0.

It is used as a terminal-only fallback so shell prompts can render Nerd Font
icon glyphs without replacing the app's normal monospace font stack.

See `NERD_FONTS_LICENSE.md` for the upstream license text.
