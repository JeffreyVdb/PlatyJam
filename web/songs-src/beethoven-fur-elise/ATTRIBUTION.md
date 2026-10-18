# Attribution

```
Für Elise (Bagatelle No. 25 in A minor), WoO 59, by L. van Beethoven (1770–1827), 1810.
Typeset by Stelios Samelis for the Mutopia Project (Mutopia-2015/08/18-931), from the
Breitkopf & Härtel edition of 1888, with LilyPond 2.18.2.
Public Domain: placed in the public domain by the typesetter; free to distribute,
modify, and perform.
https://www.mutopiaproject.org/legal.html#publicdomain
```

`fur_Elise_WoO59.mid` was downloaded on 2026-10-18 from
https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59.mid
(piece page: https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=931) and is unmodified
(SHA-256 `1c12c21c7bbf4cf163896732672648a69d497636059837abd153c71abe50215a`).
Track `up:` (the right hand) becomes the tiles; track `down:` (the left hand) is the
accompaniment. 3/8 at 72 quarter notes per minute, as marked in the source.

Repeats: the LilyPond source has `\repeat volta` blocks but does not unfold them for MIDI,
so the file (104 bars, 2:10) plays each section once. Where a repeat has two endings, both
are played back to back: after the opening theme the MIDI plays the first ending (A as a
quarter note) and goes straight on to the second ending (A, then B C D into the second
theme), and the same happens before the third theme. Each such spot adds one bar that
lingers on the cadence note. Every section is complete and in order, so the piece is
shorter than a performance with repeats but not broken.
