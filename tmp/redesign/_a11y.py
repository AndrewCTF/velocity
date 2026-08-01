#!/usr/bin/env python3
"""Upgrade the mockups' clickable-looking elements into real controls.

The spec claims every interactive primitive is keyboard reachable and carries a
role and an accessible name. A mockup that asserts that while using <div> and
<span> for its rows, chips and tools is not demonstrating the contract, it is
just saying it. This makes the claim checkable in a browser:

  .tool    -> <button aria-label>            (name came from title only)
  .chip    -> <button aria-pressed>          (a filter is a toggle, not a label)
  .toggle  -> <button role=switch aria-checked>
  .row     -> focusable; rows that already contain a switch put the focus on the
              label instead, so a row never nests one control inside another
  .pitem   -> <button> (palette results)
  .p       -> <button aria-pressed> (pinned-panel strip)
  .dot     -> aria-hidden, it is decoration that a status word already carries

Run standalone to fix the hand-written pages, or import `upgrade` from _build.py
for the generated ones.
"""
import re, sys, pathlib

def _tool(m):
    cls, title = m.group(1), m.group(2)
    return f'<button type="button" class="{cls}" title="{title}" aria-label="{title}">'

def _viewbox(html: str) -> str:
    """Give every inline <svg> that references a symbol a viewBox.

    Without one there is no scaling: the symbol's 24-unit coordinates are drawn
    1:1 into a 15px viewport, so only the top-left 15x15 corner of each icon is
    visible. Every icon in these mockups was silently cropped until this landed.
    """
    def fix(m):
        tag = m.group(0)
        return tag if 'viewBox' in tag else tag[:-1] + ' viewBox="0 0 24 24">'
    return re.sub(r'<svg(?![^>]*\bstyle="display:none")[^>]*>', fix, html)


def upgrade(html: str) -> str:
    html = _viewbox(html)
    # toolbar tools: div + title -> button with a real accessible name
    html = re.sub(r'<div class="(tool[^"]*)" title="([^"]+)">', _tool, html)
    html = re.sub(r'(<button type="button" class="tool[^"]*"[^>]*>)(\s*<svg[\s\S]*?</svg>\s*)</div>',
                  r'\1\2</button>', html)

    # switches
    def _toggle(m):
        cls = m.group(1)
        on = 'true' if 'on' in cls.split() else 'false'
        label = 'Layer on' if on == 'true' else 'Layer off'
        return (f'<button type="button" class="{cls}" role="switch" aria-checked="{on}" '
                f'aria-label="{label}"><i aria-hidden="true"></i></button>')
    html = re.sub(r'<span class="(toggle[^"]*)"><i></i></span>', _toggle, html)

    # chips are filters, so they are pressed-state buttons
    def _chip(m):
        cls, inner = m.group(1), m.group(2)
        on = 'true' if 'on' in cls.split() else 'false'
        return f'<button type="button" class="{cls}" aria-pressed="{on}">{inner}</button>'
    html = re.sub(r'<span class="(chip[^"]*)"(?: style="[^"]*")?(?: title="[^"]*")?>([\s\S]*?)</span>',
                  _chip, html)

    # pinned-panel strip
    def _pin(m):
        cls, inner = m.group(1), m.group(2)
        on = 'true' if 'on' in cls.split() else 'false'
        return f'<button type="button" class="{cls}" aria-pressed="{on}">{inner}</button>'
    html = re.sub(r'<span class="(p|p on)"(?: style="[^"]*")?>([^<]*)</span>', _pin, html)

    # palette results
    html = re.sub(r'<div class="(pitem[^"]*)">', r'<div class="\1" role="option" tabindex="0">', html)

    # rows: focus goes on the label when the row already owns a switch, so a
    # control is never nested inside another control
    def _row(m):
        cls, inner = m.group(1), m.group(2)
        if 'role="switch"' in inner:
            inner = inner.replace('<span class="nm">', '<span class="nm" role="button" tabindex="0">', 1)
            return f'<div class="{cls}" role="group">{inner}</div>'
        return f'<div class="{cls}" role="button" tabindex="0">{inner}</div>'
    html = re.sub(r'<div class="(row[^"]*)">((?:(?!<div class="row)[\s\S])*?)</div>\n',
                  lambda m: _row(m) + '\n', html)

    # decorative status dots already have a word beside them
    html = html.replace('<span class="dot', '<span aria-hidden="true" class="dot')
    return html


if __name__ == '__main__':
    for p in sys.argv[1:]:
        f = pathlib.Path(p)
        before = f.read_text()
        after = upgrade(before)
        if after != before:
            f.write_text(after)
            print('upgraded', f.name)
        else:
            print('unchanged', f.name)
