# Third-party notices

Cardwright uses Pi 0.85.1, Electron, React and the exact dependency versions listed in package-lock.json. Dependency packages retain their own license files in the packaged node_modules directory. Electron/Chromium license notices are distributed with the executable.

Version 0.3 integrates the MIT-licensed Pi ecosystem packages listed in the project's architecture records, using original factories, core helpers, prompts and skill text as described there. Their original license files remain in `node_modules`. `pi-tool-display` is a design/feature reference only; its incompatible runtime is not distributed or executed. `adm-zip` is overridden to patched 0.6.1. Package versions and transitive dependencies are locked in `package-lock.json`.

Version 0.2 adopts Cardwright's Studio direction after user feedback rejected the earlier visual imitation. No Claude Desktop or Claude Code source code, fonts, executable assets, or credentials were incorporated.

The Brave Search REST mapping adapts Mario Zechner's MIT-licensed pi-skills implementation (copyright 2024). Its full notice and source links are preserved in the private development repository and reproduced here: Brave Search REST mapping from pi-skills, copyright 2024 Mario Zechner, MIT licence. Codex search code was researched for interface boundaries; no Codex backend, credentials, or source code was incorporated.

Version 0.7.1 bundles two fonts from the official Google Fonts repository (github.com/google/fonts, `ofl/chakrapetch` and `ofl/sharetechmono`) under the SIL Open Font License 1.1: Chakra Petch Regular, Medium, SemiBold and Bold (Copyright 2018 The Chakra Petch Project Authors (https://github.com/m4rc1e/Chakra-Petch.git)) and Share Tech Mono Regular (Copyright (c) 2012, Carrois Type Design, Ralph du Carrois (post@carrois.com www.carrois.com), with Reserved Font Name 'Share'). The unmodified font files and their complete license texts are in `src/renderer/assets/fonts/` and are copied into the packaged renderer assets. The fonts are not sold on their own.

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
