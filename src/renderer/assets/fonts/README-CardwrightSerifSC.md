# CardwrightSerifSC.woff2

The card studio's serif, `'Cardwright Serif'` in `src/renderer/card-studio/card-studio.css` (decision Q12c): a subset of Noto Serif SC under the SIL Open Font License 1.1. `OFL-NotoSerifSC.txt` is the unmodified `OFL.txt` from the same source folder.

- **Source:** `NotoSerifSC[wght].ttf` (version 2.003, 25,125,512 bytes, sha256 `050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9`) from github.com/google/fonts at commit `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5`: https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf
- **Tool:** subset-font 2.9.0 (HarfBuzz hb-subset through harfbuzzjs 1.6.2) on Node 24, installed outside the repository: `subsetFont(ttf, text, { targetFormat: 'sfnt', preserveNameIds: [7, 8, 9, 10, 11, 12, 13, 14] })`, then fontverter's WOFF2 conversion. No `variationAxes`, so the `wght` axis (200–900) stays variable. Layout tables and hinting are hb-subset's defaults; the name table keeps IDs 0–14, including the copyright (ID 0) and the license and its URL (IDs 13 and 14).
- **Characters** (7,136 requested, 7,118 in the result's cmap):
  - ASCII U+0020–U+007E (95);
  - CJK and full-width punctuation (278): U+3000–U+303F, U+2010–U+203E, U+FF01–U+FF65, U+FFE0–U+FFE6 and GB2312 rows 1 and 3 (0xA1A1–0xA1FE, 0xA3A1–0xA3FE);
  - the 6,763 GB2312 hanzi: each cell of 0xB0A1–0xF7FE decoded with Node's `TextDecoder('gbk')`, skipping cells that decode to U+FFFD or to the private use area (0xD7FA–0xD7FE);
  - every CJK character (Han, CJK and full-width punctuation, General Punctuation, `·×÷`) in `src/renderer/**/*.{ts,tsx}` and `src/shared/**/*.ts` on 2026-09-24: 867, all already inside the sets above.

  The font lacks 20 of the requested General Punctuation code points (U+2017, U+201B, U+201F, U+2023, U+2024, U+2028–U+202F, U+2031, U+2034, U+2036–U+2038, U+203D, U+203E); hb-subset adds the mirrored pairs U+220B and U+2245.
- **Result:** WOFF2, 2,533,864 bytes, sha256 `fcbc1f2959dc5162273b2d360ebe6862b1885e592bd2487470c9568ce31463d0`. Running the recipe again gives the same bytes.

Characters outside the subset, such as rarer or traditional hanzi in a user's card, fall back one by one to the rest of `--cs-serif`. When the subset changes, update this note and `THIRD_PARTY_NOTICES.md`; `test/studio-css.test.ts` keeps the file under 4 MB.
