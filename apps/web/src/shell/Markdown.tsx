// Shared markdown renderer for AI/LLM prose (assessment briefs, investigate
// answers, incident narratives). react-markdown renders straight to React
// elements — no dangerouslySetInnerHTML anywhere — and raw HTML in the source
// text is SKIPPED by default (no rehype-raw here, ever): a `<script>` or
// `<img onerror>` in model output must never become a live DOM node.
// Styling maps each markdown element onto the token system (tokens.css):
// --fs-* type scale, txt/bg/line/accent color tokens, compact panel margins.
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const BODY = 'text-[length:var(--fs-dense)] text-txt-1 leading-snug';

// Headings compressed onto the 3-step token scale (nothing below the 10px
// floor): h1/h2 → body size, h3/h4 → dense, h5/h6 → caption eyebrow.
const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-[length:var(--fs-body)] font-semibold text-txt-0 mt-2 mb-1 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[length:var(--fs-body)] font-semibold text-txt-0 mt-2 mb-1 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[length:var(--fs-dense)] font-semibold text-txt-0 mt-1.5 mb-0.5 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[length:var(--fs-dense)] font-semibold text-txt-0 mt-1.5 mb-0.5 first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-[length:var(--fs-caption)] font-semibold uppercase tracking-[0.06em] text-txt-2 mt-1.5 mb-0.5 first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-[length:var(--fs-caption)] font-semibold uppercase tracking-[0.06em] text-txt-2 mt-1.5 mb-0.5 first:mt-0">
      {children}
    </h6>
  ),
  p: ({ children }) => <p className={`${BODY} my-1 first:mt-0 last:mb-0`}>{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-4 my-1 space-y-0.5 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 my-1 space-y-0.5 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className={BODY}>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-txt-0">{children}</strong>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline decoration-accent-line underline-offset-2 hover:text-accent-fg break-words"
    >
      {children}
    </a>
  ),
  // Inline code = mono chip on --bg-3; the same `code` component also renders
  // inside fenced blocks, where the parent <pre> resets the chip styling.
  code: ({ children }) => (
    <code className="mono text-[length:var(--fs-caption)] bg-bg-3 text-txt-0 px-1 py-px rounded-sm break-words">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mono text-[length:var(--fs-caption)] bg-bg-3 text-txt-0 rounded-sm p-2 my-1.5 overflow-x-auto leading-snug [&>code]:bg-transparent [&>code]:p-0 [&>code]:break-normal">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line-2 pl-2 my-1 text-txt-2">{children}</blockquote>
  ),
  hr: () => <hr className="border-line my-2" />,
  // GFM tables scroll inside their own container — never widen the panel.
  table: ({ children }) => (
    <div className="overflow-x-auto my-1.5">
      <table className="border-collapse text-[length:var(--fs-caption)]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-bg-2 px-1.5 py-0.5 text-left font-semibold text-txt-2">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-1.5 py-0.5 text-txt-1">{children}</td>,
};

interface Props {
  text: string;
  className?: string;
}

// <Markdown text={...} /> — drop-in replacement for the plain <p> that AI
// text used to render through; compact enough to live inside dense panels.
export function Markdown({ text, className = '' }: Props): JSX.Element {
  return (
    <div className={`min-w-0 ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
