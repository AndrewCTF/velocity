import { useMemo } from 'react';
import ms from 'milsymbol';
import { Widget, Caveat, Badge } from '../shell/instruments.js';
import { useCop } from './copStore.js';
import type { CopUnit } from './notionalCop.js';

// Order-of-Battle tree for the COP workspace. Builds a parent→child hierarchy
// from the COP units' `higher` (higherFormation) field and renders each node with
// its MIL-STD-2525 symbol (milsymbol, the same lib the map layer uses). NOTIONAL
// only — there is no live order-of-battle feed — and labelled as such.

function symbolDataUrl(sidc: string): string {
  try {
    return new ms.Symbol(sidc, { size: 22 }).toDataURL();
  } catch {
    return '';
  }
}

interface Node {
  unit: CopUnit;
  children: Node[];
}

function buildForest(units: CopUnit[]): Node[] {
  const byHigher = new Map<string, CopUnit[]>();
  const designations = new Set(units.map((u) => u.designation));
  for (const u of units) {
    const key = u.higher ?? '';
    byHigher.set(key, [...(byHigher.get(key) ?? []), u]);
  }
  const childrenOf = (u: CopUnit): Node[] =>
    (byHigher.get(u.designation) ?? []).map((c) => ({ unit: c, children: childrenOf(c) }));
  // Roots: no `higher`, or a `higher` that isn't itself a unit in this set.
  const roots = units.filter((u) => !u.higher || !designations.has(u.higher));
  return roots.map((u) => ({ unit: u, children: childrenOf(u) }));
}

function TreeNode({ node, depth }: { node: Node; depth: number }): JSX.Element {
  const url = useMemo(() => symbolDataUrl(node.unit.sidc), [node.unit.sidc]);
  return (
    <li>
      <div
        className="flex items-center gap-2 py-[3px] pr-1 rounded-sm hover:bg-bg-2/60 transition-colors"
        style={{ paddingLeft: depth * 14 + 2, borderLeft: depth > 0 ? '1px solid var(--line)' : undefined }}
      >
        {url ? (
          <img src={url} alt="" className="h-5 w-5 object-contain shrink-0" />
        ) : (
          <span className="h-5 w-5 inline-block bg-bg-3 rounded-sm shrink-0" />
        )}
        <span className="text-[11px] text-txt-1 flex-1 truncate">{node.unit.designation}</span>
        {node.children.length > 0 && <Badge tone="neutral">{node.children.length}×</Badge>}
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.unit.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrbatTree(): JSX.Element {
  const units = useCop((s) => s.units);
  const forest = useMemo(() => buildForest(units), [units]);

  return (
    <Widget title="Order of Battle">
      <div className="space-y-2">
        <Caveat level="NOTIONAL" note="illustrative — no live order-of-battle feed" tone="warn" />
        {forest.length === 0 ? (
          <p className="text-[10.5px] text-txt-3">No units placed.</p>
        ) : (
          <ul>
            {forest.map((n) => (
              <TreeNode key={n.unit.id} node={n} depth={0} />
            ))}
          </ul>
        )}
      </div>
    </Widget>
  );
}
