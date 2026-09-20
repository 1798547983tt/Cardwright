import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(new URL('../src/renderer', import.meta.url));
const stylesheets = [...readdirSync(renderer).filter(name => name.endsWith('.css')).map(name => join(renderer, name)),
  ...readdirSync(join(renderer, 'card-studio')).filter(name => name.endsWith('.css')).map(name => join(renderer, 'card-studio', name))];

// The slash and @ menus float above the input from inside these containers. A clip-path or hidden overflow on any of
// them cuts the menu off: on the 0.8 home page only a dark sliver of the slash menu showed.
test('the containers of the slash and @ menus never clip them', () => {
  const containers = ['.composer-region', '.composer-box', '.attachment-composer', '.cs-composer', '.cs-composer-box'];
  for (const file of stylesheets) {
    const css = readFileSync(file, 'utf8');
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of selectors.split(',').map(item => item.trim())) {
        const target = containers.find(name => new RegExp(`${name.replace('.', '\\.')}(?:[:.[][^\\s>+~]*)?$`).test(selector) && !/::(before|after)$/.test(selector));
        if (!target) continue;
        assert.doesNotMatch(body, /(?:^|;)\s*clip-path\s*:/, `${file}: ${selector} clips the menus with clip-path`);
        assert.doesNotMatch(body, /(?:^|;)\s*overflow(?:-[xy])?\s*:\s*(hidden|clip)/, `${file}: ${selector} hides the menus' overflow`);
      }
    }
  }
});

// 0.9 quieted the workbench (§6.5). The motion layer is shared with the card studio, so it must not keep animating
// the HUD parts that are gone: those rules only cost paint and mislead the next reader.
test('the motion layer animates nothing the workbench no longer renders', () => {
  const css = readFileSync(join(renderer, 'motion.css'), 'utf8');
  for (const gone of ['hud-marquee', 'nav-slab', 'channel-tab', 'hud-module', 'hud-logo', 'new-task-button', 'task-row', 'shell-grain', 'shell-grid', 'shell-beam', 'reveal-1']) {
    assert.ok(!css.includes(gone), `motion.css still animates .${gone}`);
  }
  assert.match(css, /html\[data-motion="reduced"\][^{]*\{[^}]*animation:\s*none/);
  assert.match(css, /html\[data-motion="reduced"\][^{]*\{[^}]*transition:\s*none/);
});

// Under 960px the three columns do not fit; the side panel becomes a drawer over the conversation (§6.3).
test('the desk has a narrow layout where the side panel is a drawer', () => {
  const css = readFileSync(join(renderer, 'workbench.css'), 'utf8');
  const narrow = /@media \(max-width: 960px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(narrow, 'workbench.css has a 960px block');
  assert.match(narrow[1], /\.desk-panel[^{]*\{[^}]*position:\s*fixed/);
  assert.match(narrow[1], /\.desk-shell[^{]*\{[^}]*grid-template-columns/);
});

// The production minifier folds `font-stretch: condensed` into a literal `font` shorthand as `75%`, which the shorthand
// does not accept, so the browser drops the whole font declaration (the archive cover's ARCHIVE word shrank to 14px).
test('font-stretch never shares a block with a literal font shorthand', () => {
  for (const file of stylesheets) {
    const css = readFileSync(file, 'utf8');
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/font-stretch\s*:/.test(body)) continue;
      const shorthand = /(?:^|;)\s*font\s*:\s*([^;]*)/.exec(body);
      if (shorthand && !shorthand[1].includes('var(')) assert.fail(`${file}: ${selector.trim()} sets font-stretch next to a literal font shorthand`);
    }
  }
});
