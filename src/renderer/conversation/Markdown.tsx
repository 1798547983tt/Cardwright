import { createContext, memo, useContext, useMemo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMarkdownBlocks } from './blocks';
import { CodeView } from './CodeView';
import type { Skin } from './parts';

type Plugins = Options['remarkPlugins'];
/** The part of a hast node the kernel reads. */
interface HastNode { type: string; tagName?: string; value?: string; children?: HastNode[]; properties?: Record<string, unknown> }

const PLAIN: Plugins = [remarkGfm];
const VOID = new Set(['br', 'hr', 'img', 'input']);

/** Puts the streaming cursor after the last text of the tail block (handoff §5.5 ④); a code block shows its own. */
function rehypeCursor() {
  return (tree: HastNode) => {
    const cursor: HastNode = { type: 'element', tagName: 'span', properties: { className: ['conv-cursor'], ariaHidden: 'true' }, children: [] };
    for (let parent = tree; ;) {
      const children = parent.children ??= [];
      let index = children.length - 1;
      while (index >= 0 && children[index].type === 'text' && !children[index].value?.trim()) index--;
      const last = children[index];
      if (!last) { children.push(cursor); return; }
      if (last.type === 'element' && last.tagName === 'pre') return;
      if (last.type === 'element' && !VOID.has(last.tagName ?? '')) { parent = last; continue; }
      children.splice(index + 1, 0, cursor);
      return;
    }
  };
}
const CURSOR: Options['rehypePlugins'] = [rehypeCursor];

/** What a block tells the code blocks inside it: the skin, and whether it ends in a fence still being written. */
interface BlockState { skin: Skin; open: boolean; end: number }
const BlockContext = createContext<BlockState>({ skin: 'workbench', open: false, end: 0 });

const textOf = (node: HastNode): string => node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join('');

function Pre({ node }: ExtraProps) {
  const block = useContext(BlockContext);
  const code = (node?.children as HastNode[] | undefined)?.find(child => child.type === 'element' && child.tagName === 'code');
  const classes = code?.properties?.className;
  const language = (Array.isArray(classes) ? classes.map(String) : []).find(name => name.startsWith('language-'))?.slice('language-'.length);
  const streaming = block.open && (node?.position?.end.offset ?? -1) >= block.end - 1;
  return <CodeView code={code ? textOf(code).replace(/\n$/, '') : ''} language={language} streaming={streaming} skin={block.skin} />;
}

/** Tables scroll sideways inside the reading column, with striped rows (handoff §5.5 ⑧). */
function Table({ node: _node, ...props }: ComponentProps<'table'> & ExtraProps) {
  return <div className="conv-table"><table {...props} /></div>;
}

interface BlockProps { text: string; open: boolean; tail: boolean; skin: Skin; remarkPlugins: Plugins; components: Components; urlTransform?: Options['urlTransform'] }

/** One top-level block, parsed again only when its own text changes. */
const Block = memo(function Block({ text, open, tail, skin, remarkPlugins, components, urlTransform }: BlockProps) {
  const state = useMemo(() => ({ skin, open, end: text.length }), [skin, open, text.length]);
  return <BlockContext.Provider value={state}>
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={tail ? CURSOR : undefined} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>
  </BlockContext.Provider>;
});

export interface MarkdownProps {
  text: string;
  /** The reply is still being written: its last block carries the cursor, and a fence left open is a block being written. */
  streaming?: boolean;
  skin?: Skin;
  remarkPlugins?: Plugins;
  /** The skin's own elements (links, inline code); code blocks and tables are the kernel's. Pass a stable object. */
  components?: Components;
  urlTransform?: Options['urlTransform'];
}

/**
 * The conversation's Markdown (handoff §5.5 ⑥): the text is cut into top-level blocks rendered side by side, so the
 * skins' sibling rules still apply and a streaming reply re-parses only its tail.
 */
export function Markdown({ text, streaming = false, skin = 'workbench', remarkPlugins = PLAIN, components, urlTransform }: MarkdownProps) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  const merged = useMemo<Components>(() => ({ ...components, pre: Pre, table: Table }), [components]);
  return <>{blocks.map((block, index) => <Block key={index} text={block.text} open={streaming && !!block.open} tail={streaming && index === blocks.length - 1}
    skin={skin} remarkPlugins={remarkPlugins} components={merged} urlTransform={urlTransform} />)}</>;
}
