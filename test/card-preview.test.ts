import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { displayRegex, previewDocument, regexFromString, renderReply, runRegexScript, updateBlocks, wrapQuotes, type PreviewRegex } from '../src/shared/card-studio/preview.ts';

const macros = { char: '雾港档案', user: '玩家' };
const script = (over: Partial<PreviewRegex>): PreviewRegex => ({
  scriptName: '样例', findRegex: '/x/', replaceString: '', trimStrings: [], placement: [2], disabled: false,
  markdownOnly: true, promptOnly: false, minDepth: null, maxDepth: null, substituteRegex: 0, ...over,
});

test('find expressions are read the way SillyTavern reads them', () => {
  const full = regexFromString(String.raw`/<content>([\s\S]*?)<\/content>/is`);
  assert.equal(full?.flags, 'is');
  assert.equal(full?.source, String.raw`<content>([\s\S]*?)<\/content>`);
  assert.deepEqual([regexFromString('雾港')?.source, regexFromString('雾港')?.flags], ['雾港', ''], 'without slashes the whole text is the pattern');
  assert.equal(regexFromString('/a/zz')?.source, String.raw`\/a\/zz`, 'unknown flags make the whole text a pattern');
  assert.equal(regexFromString('/(/'), undefined, 'a pattern that does not compile is skipped');
});

test('a replacement follows SillyTavern: groups, {{match}}, trim strings, macros', () => {
  assert.equal(runRegexScript(script({ findRegex: '/<b>(.*?)<\\/b>/g', replaceString: '[{{match}}|$1]' }), 'x<b>一</b>y<b>二</b>', macros), 'x[<b>一</b>|一]y[<b>二</b>|二]');
  assert.equal(runRegexScript(script({ findRegex: '/(?<who>林砚)(说)?/', replaceString: '$<who>:$2|' }), '林砚来了', macros), '林砚:|来了', 'a named group, and an optional group that did not match, gives nothing');
  assert.equal(runRegexScript(script({ findRegex: '/「(.*?)」/', replaceString: '<q>$1</q>', trimStrings: ['嗯'] }), '「嗯，好」', macros), '<q>，好</q>', 'trim strings come out of the captured text');
  assert.equal(runRegexScript(script({ findRegex: '/@/', replaceString: '{{char}}对{{User}}说' }), '@', macros), '雾港档案对玩家说');
  assert.equal(runRegexScript(script({ findRegex: '/<b>(.*?)<\\/b>/', replaceString: '$1' }), '<b>{{user}}</b>', macros), '玩家', 'macros in the captured text are filled in as well');
  assert.equal(runRegexScript(script({ findRegex: '/a/', replaceString: '$$' }), 'a', macros), '$$', 'SillyTavern leaves $$ as it is');
  assert.equal(runRegexScript(script({ findRegex: '/a/', replaceString: 'b' }), 'aaa', macros), 'baa', 'without g only the first match is replaced');
});

test('the latest reply runs the regex that change the message first, then the display-only ones at depth 0, in card order', () => {
  const scripts = [
    script({ scriptName: '存档替换', findRegex: '/〔旧〕/g', replaceString: '〔新〕', markdownOnly: false }),
    script({ scriptName: '只改提示词', findRegex: '/雾/g', replaceString: '霾', markdownOnly: false, promptOnly: true }),
    script({ scriptName: '已停用', findRegex: '/雾/g', replaceString: '霾', disabled: true }),
    script({ scriptName: '只管用户输入', findRegex: '/雾/g', replaceString: '霾', placement: [1] }),
    script({ scriptName: '旧楼层', findRegex: '/雾/g', replaceString: '霾', minDepth: 1 }),
    script({ scriptName: '坏正则', findRegex: '/(/', replaceString: '' }),
    script({ scriptName: '新字样', findRegex: '/〔新〕/', replaceString: '<i>新</i>' }),
    script({ scriptName: '占位符', findRegex: '/<StatusPlaceHolderImpl\\/>/', replaceString: '<div data-bar></div>', maxDepth: 0 }),
    script({ scriptName: '状态栏', findRegex: '/<div data-bar><\\/div>/', replaceString: '<div data-bar>状态</div>' }),
    script({ scriptName: '没命中', findRegex: '/<none>/', replaceString: '' }),
  ];
  const result = displayRegex('雾里〔旧〕<StatusPlaceHolderImpl/>', scripts, macros);
  assert.equal(result.text, '雾里<i>新</i><div data-bar>状态</div>');
  assert.deepEqual(result.steps.map(step => [step.name, step.outcome, step.stage]), [
    ['存档替换', 'applied', 'stored'], ['只改提示词', 'skipped', null], ['已停用', 'skipped', null], ['只管用户输入', 'skipped', null],
    ['旧楼层', 'skipped', 'display'], ['坏正则', 'skipped', 'display'], ['新字样', 'applied', 'display'], ['占位符', 'applied', 'display'],
    ['状态栏', 'applied', 'display'], ['没命中', 'no-match', 'display'],
  ]);
  assert.match(result.steps[4].reason ?? '', /深度/);
  assert.match(result.steps[5].reason ?? '', /编译/);
});

test('quotes are wrapped the way SillyTavern 1.19.0 does it, outside tags, styles and code', () => {
  assert.equal(wrapQuotes('他说「走吧」。'), '他说<q>「走吧」</q>。');
  assert.equal(wrapQuotes('<div class="a">"hi"</div>'), '<div class="a"><q>"hi"</q></div>');
  assert.equal(wrapQuotes('<style>.a::before { content: "x"; }</style>'), '<style>.a::before { content: "x"; }</style>');
  assert.equal(wrapQuotes('```\n"code"\n```'), '```\n"code"\n```');
  assert.equal(wrapQuotes('<pre>{"op": "replace"}</pre>'), '<pre>{<q>"op"</q>: <q>"replace"</q>}</pre>', 'JSON in a pre is not spared, as in SillyTavern');
});

test('a reply splits into frontend documents and Markdown text, and lists what would need the network', () => {
  const reply = [
    '开场「对白」',
    'a',
    '',
    '<section>',
    '  <details>',
    '',
    '    <summary>回执</summary>',
    '  </details>',
    '</section>',
    '```html',
    '<!DOCTYPE html><html><head><link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet"></head><body><script src="https://cdn.jsdelivr.net/npm/x.js"></script><p id="app"></p></body></html>',
    '```',
    '```',
    'plain <code> "kept"',
    '```',
  ].join('\n');
  const result = renderReply(reply, [], macros);
  assert.deepEqual(result.segments.map(segment => segment.kind), ['html', 'frontend', 'html']);
  const [before, frontend, after] = result.segments;
  assert.ok(before.html.includes('<p>开场<q>「对白」</q><br>a</p>'), before.html);
  assert.ok(before.html.includes('<section>\n  <details>\n\n    <summary>回执</summary>\n  </details>\n</section>'), 'an HTML block passes through whole, blank lines and all');
  assert.ok(frontend.html.startsWith('<!DOCTYPE html>') && frontend.html.includes('<p id="app"></p>'), 'the code block holding a document is the document');
  assert.ok(after.html.includes('<pre><code>plain &lt;code&gt; "kept"</code></pre>'), 'a code block without a document stays code');
  assert.deepEqual(result.external, ['cdn.jsdelivr.net', 'fonts.googleapis.com']);
});

test('the update preview takes the <UpdateVariable> block, finished and still streaming', () => {
  const sample = ['<content>雾。</content>', '<UpdateVariable>', '<Analysis>天气没变</Analysis>', '<JSONPatch>[]</JSONPatch>', '</UpdateVariable>'].join('\n');
  assert.deepEqual(updateBlocks(sample), {
    done: '<UpdateVariable>\n<Analysis>天气没变</Analysis>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>',
    streaming: '<UpdateVariable>\n<Analysis>天气没变</Analysis>\n<JSONPatch>[]</JSONPatch>',
  });
  assert.equal(updateBlocks('<content>雾。</content>'), null);
});

test('each preview document carries its own policy: no network, and scripts only where SillyTavern would run them', () => {
  const frontend = previewDocument({ kind: 'frontend', html: '<!DOCTYPE html><html><body><script>go()</script></body></html>' }, 'n0nce');
  assert.match(frontend.csp, /default-src 'none'/);
  assert.match(frontend.csp, /script-src 'unsafe-inline'/, 'a document in a code block runs its scripts, as in the iframe 酒馆助手 makes');
  assert.ok(frontend.html.includes('<script>go()</script>'));
  assert.match(frontend.html, /box-sizing/, 'with the base style 酒馆助手 gives its iframes');
  const text = previewDocument({ kind: 'html', html: '<p>雾<script>go()</script></p>' }, 'n0nce');
  assert.equal(/script-src ([^;]*)/.exec(text.csp)?.[1], "'nonce-n0nce'", 'the message itself runs no scripts of its own: SillyTavern strips them');
  assert.match(text.html, /class="mes_text"/);
  assert.match(text.html, /<script nonce="n0nce">/, 'only the preview reporter runs');
  for (const document of [frontend, text]) assert.doesNotMatch(document.csp, /connect-src|https?:/, 'nothing reaches the network');
});

// Handoff §5.2: without the fence a replacement is message text, and SillyTavern sanitizes it (knowledge base 30, §5):
// classes get custom-, the replacement's own <style> is scoped to .mes_text, scripts and unknown tags go. The preview
// shows it the same way, so an unfenced front-end looks as broken here as it will there.
test('message text is sanitized the way SillyTavern sanitizes it before it is shown', () => {
  const text = previewDocument({ kind: 'html', html: '<section class="cw-update fa-star"><style>:root { --ink: red; } .cw-update summary { color: var(--ink); }</style><summary>回执</summary><script>go()</script></section>' }, 'n0nce');
  const body = text.html.slice(text.html.indexOf('<body>'));
  const template = /<template id="cardwright-message">([\s\S]*?)<\/template>/.exec(body);
  assert.ok(template, 'the message waits in an inert template, where its styles do not apply and its scripts do not run');
  assert.ok(template[1].includes('<section class="cw-update fa-star">'));
  assert.match(body, /<div class="mes_text"><\/div>/, 'nothing reaches the message box unsanitized');
  const sanitizer = [...body.matchAll(/<script nonce="n0nce">([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  for (const rule of ["'custom-'", "'fa-'", "'note-'", "'monospace'", "'.mes_text '", 'CSSStyleSheet', 'HTMLUnknownElement'])
    assert.ok(sanitizer.includes(rule), `the sanitizer handles ${rule}`);
});

test("the window's own policy admits frames from the preview scheme only, and still runs no inline script", async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const policy = /Content-Security-Policy" content="([^"]+)"/.exec(page)?.[1] ?? '';
  const directive = (name: string) => policy.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `))?.slice(name.length + 1).trim();
  assert.equal(directive('frame-src'), 'cardwright-preview:');
  assert.equal(directive('script-src'), "'self'");
});
