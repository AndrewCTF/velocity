// Markdown.tsx — the shared AI-text renderer. Two contracts under test:
// 1. structured markdown (bold / lists / headings / GFM tables, links, code)
//    actually becomes semantic elements, not literal `*`/`(1)` text;
// 2. raw HTML in model output is NEVER materialized as DOM — no rehype-raw,
//    no dangerouslySetInnerHTML — so <script>/<img onerror> injection is inert.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown.js';

describe('Markdown', () => {
  it('renders bold, list, and heading markdown as semantic elements', () => {
    const { container } = render(
      <Markdown text={'## Assessment\n\nVessel is **dark** near TSS.\n\n- gap 3h\n- SAR hit\n\n1. verify'} />,
    );
    const h2 = container.querySelector('h2');
    expect(h2).toHaveTextContent('Assessment');
    const strong = container.querySelector('strong');
    expect(strong).toHaveTextContent('dark');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(1);
    // No literal markdown markers leak into the text.
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('##');
  });

  it('renders GFM tables inside a scrollable container and inline code as a chip', () => {
    const { container } = render(
      <Markdown text={'| a | b |\n| - | - |\n| 1 | 2 |\n\nuse `icao24` here'} />,
    );
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
    const code = container.querySelector('code');
    expect(code).toHaveTextContent('icao24');
  });

  it('opens links in a new tab with rel=noreferrer', () => {
    render(<Markdown text={'[docs](https://example.com/x)'} />);
    const a = screen.getByRole('link', { name: 'docs' });
    expect(a).toHaveAttribute('href', 'https://example.com/x');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noreferrer');
  });

  it('does not create elements from raw HTML injection', () => {
    const { container } = render(
      <Markdown
        text={'before <script>window.__pwned = true</script> <img src=x onerror="window.__pwned2=true"> after'}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__pwned2).toBeUndefined();
    // The surrounding legitimate text still renders.
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
  });

  it('renders a plain one-line string as a single tight paragraph', () => {
    const { container } = render(<Markdown text="No cross-domain incidents." />);
    const ps = container.querySelectorAll('p');
    expect(ps).toHaveLength(1);
    expect(ps[0]).toHaveTextContent('No cross-domain incidents.');
  });
});
