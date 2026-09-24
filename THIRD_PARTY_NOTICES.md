# Third-party notices

Cardwright uses Pi 0.85.1, Electron, React and the exact dependency versions listed in package-lock.json. Dependency packages retain their own license files in the packaged node_modules directory. Electron/Chromium license notices are distributed with the executable.

Version 0.3 integrates the MIT-licensed Pi ecosystem packages listed in the project's architecture records, using original factories, core helpers, prompts and skill text as described there. Their original license files remain in `node_modules`. `pi-tool-display` is a design/feature reference only; its incompatible runtime is not distributed or executed. `adm-zip` is overridden to patched 0.6.1. Package versions and transitive dependencies are locked in `package-lock.json`.

Version 0.2 adopts Cardwright's Studio direction after user feedback rejected the earlier visual imitation. No Claude Desktop or Claude Code source code, fonts, executable assets, or credentials were incorporated.

The Brave Search REST mapping adapts Mario Zechner's MIT-licensed pi-skills implementation (copyright 2024). Its full notice and source links are preserved in the private development repository and reproduced here: Brave Search REST mapping from pi-skills, copyright 2024 Mario Zechner, MIT licence. Codex search code was researched for interface boundaries; no Codex backend, credentials, or source code was incorporated.

Version 0.7.1 bundles two fonts from the official Google Fonts repository (github.com/google/fonts, `ofl/chakrapetch` and `ofl/sharetechmono`) under the SIL Open Font License 1.1: Chakra Petch Regular, Medium, SemiBold and Bold (Copyright 2018 The Chakra Petch Project Authors (https://github.com/m4rc1e/Chakra-Petch.git)) and Share Tech Mono Regular (Copyright (c) 2012, Carrois Type Design, Ralph du Carrois (post@carrois.com www.carrois.com), with Reserved Font Name 'Share'). The unmodified font files and their complete license texts (`OFL-ChakraPetch.txt`, `OFL-ShareTechMono.txt`) are in `src/renderer/assets/fonts/`. The build bundles the fonts into the renderer assets and copies the license texts to `dist/renderer/licenses/`; both ship in the package (`resources/app/dist/renderer/` in the installed application). The fonts are not sold on their own.

Version 1.1 bundles Noto Serif SC from the same repository (`ofl/notoserifsc`, `NotoSerifSC[wght].ttf`, version 2.003) under the SIL Open Font License 1.1 as the card studio's serif: (c) 2017-2024 Adobe (http://www.adobe.com/), as the font's name table reads (the `OFL.txt` beside it is headed Copyright 2012 Google Inc. All Rights Reserved.); Noto is a trademark of Google Inc., and the license names no Reserved Font Name. It is a modified version: subset to the characters listed in `src/renderer/assets/fonts/README-CardwrightSerifSC.md` with its weight axis kept, converted to WOFF2 as `src/renderer/assets/fonts/CardwrightSerifSC.woff2` and loaded under the family name Cardwright Serif. The font file, whose name table keeps the copyright and license fields, is bundled into the renderer assets; its complete license text, `src/renderer/assets/fonts/OFL-NotoSerifSC.txt`, is copied by the build to `dist/renderer/licenses/OFL-NotoSerifSC.txt`, and both ship in the package. The font is not sold on its own.

Version 1.1 bundles highlight.js 11.12.0 (github.com/highlightjs/highlight.js, the `highlight.js` npm package) into the renderer to colour the code blocks of conversations: its core and the bash, css, diff, javascript, json, markdown, plaintext, python, typescript, xml and yaml grammars, unmodified. It is distributed under the BSD 3-Clause License; its full text is below, and the package keeps its own `LICENSE` in `node_modules`.

## Pi

Source reviewed: the pi 0.85.1 source release.
Runtime packages: @earendil-works/pi-coding-agent, @earendil-works/pi-ai, @earendil-works/pi-agent-core, version 0.85.1.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## highlight.js

Source: github.com/highlightjs/highlight.js.
Runtime package: highlight.js, version 11.12.0 (the core and eleven language grammars, bundled into the renderer).

BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
