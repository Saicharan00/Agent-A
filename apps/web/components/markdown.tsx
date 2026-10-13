import type { ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { CodeBlock } from './code-block';

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function textOf(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** A fenced block: `<pre><code class="language-x">` in the markdown AST. */
function Pre({ node }: { node?: HastNode }) {
  const code = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  const cls = code?.properties?.className;
  const className = Array.isArray(cls) ? cls.join(' ') : typeof cls === 'string' ? cls : undefined;
  return <CodeBlock code={textOf(code).replace(/\n$/, '')} className={className} />;
}

// Embedded markdown never outranks the page's own headings: `#` renders as <h3>, `##` as <h4>, and so on.
const heading =
  (Tag: 'h3' | 'h4' | 'h5' | 'h6', className: string) =>
  ({ node: _node, ...props }: ComponentProps<'h3'> & { node?: unknown }) => (
    <Tag className={className} {...props} />
  );
const COMPONENTS: Components = {
  h1: heading('h3', 'text-lg font-semibold'),
  h2: heading('h4', 'text-base font-semibold'),
  h3: heading('h5', 'font-semibold'),
  h4: heading('h6', 'font-semibold'),
  h5: heading('h6', 'font-semibold'),
  h6: heading('h6', 'font-semibold'),
  pre: ({ node }) => <Pre node={node as HastNode | undefined} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

/** Renders untrusted markdown safely (no raw HTML); fenced code gets shiki colours and a copy button. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'space-y-3 text-sm leading-relaxed break-words',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
        '[&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
        '[&_pre]:overflow-x-auto [&_pre]:p-3 [&_pre]:text-[0.85em] [&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_table]:w-full [&_table]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
