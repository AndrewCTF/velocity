// Classification marking badge — the small coloured pill shown on any classified
// object/layer/situation, plus a full-width banner for the top of a view.

import { clampLevel, LEVEL_COLOR, marking } from './classification.js';

export function MarkingBadge({
  level,
  compartments,
  title,
}: {
  level: number;
  compartments?: string[];
  title?: string;
}) {
  const lv = clampLevel(level);
  return (
    <span
      title={title ?? 'Classification marking'}
      style={{
        background: LEVEL_COLOR[lv],
        color: '#fff',
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 5px',
        borderRadius: 3,
        letterSpacing: 0.5,
        whiteSpace: 'nowrap',
      }}
    >
      {marking(level, compartments)}
    </span>
  );
}

export function ClassificationBanner({
  level,
  compartments,
}: {
  level: number;
  compartments?: string[];
}) {
  const lv = clampLevel(level);
  return (
    <div
      style={{
        background: LEVEL_COLOR[lv],
        color: '#fff',
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: 11,
        fontWeight: 700,
        textAlign: 'center',
        letterSpacing: 1,
        padding: '2px 0',
        width: '100%',
      }}
    >
      {marking(level, compartments)}
    </div>
  );
}
