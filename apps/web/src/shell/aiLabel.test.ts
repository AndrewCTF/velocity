// Every surface that renders MODEL-WRITTEN prose must carry the AI label, and
// every surface that renders RULE-WRITTEN prose must not.
//
// apps/api/app/intel/case_export.py enforces this on the evidentiary path and
// has done since the locker shipped. The panels an analyst reads all day did
// not, which is the wrong way round: the exported document is read once by
// someone who already knows it is a draft, and the entity panel is read fifty
// times a day by someone triaging.
//
// A source scan rather than a render, deliberately. Two of the three surfaces
// need a live backend, a selection and an expanded disclosure to reach their
// prose, so a render test would assert the mock and not the wiring. This asks
// the narrower question the invariant actually cares about: does the file that
// renders model prose also render the label.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// vitest runs with cwd = apps/web.
const read = (p: string): string => readFileSync(resolve(process.cwd(), 'src', p), 'utf8');

// Model-written: an LLM produced the text.
const MODEL_PROSE = [
  'entity-panel/AiAssessmentCard.tsx', // POST /api/ai/selection/brief
  'ai/WatchOfficerPanel.tsx', // POST /api/watch-officer/briefs/{id}/elaborate
  'country/BriefCard.tsx', // GET /api/country/{iso3}/brief
];

// Rule-written: intel/incidents.py builds these from templates over the domain
// set, and its own header says "Nothing is invented". Labelling them AI-DRAFTED
// would be false in the other direction, and a label that appears on
// deterministic text is a label people stop reading.
const RULE_PROSE = ['entity-panel/IntelPanel.tsx'];

describe('the AI label', () => {
  it.each(MODEL_PROSE)('is rendered by %s', (file) => {
    const src = read(file);
    expect(src).toContain('<Markdown');
    expect(src, `${file} renders model prose without <AiLabel />`).toContain('<AiLabel');
  });

  it.each(RULE_PROSE)('is NOT rendered by %s, which is deterministic', (file) => {
    expect(read(file)).not.toContain('<AiLabel');
  });

  it('says exactly one thing, in one place', async () => {
    const { AI_LABEL } = await import('./aiLabel.js');
    expect(AI_LABEL).toContain('AI-DRAFTED');
    expect(AI_LABEL).toContain('Not itself evidence');
    // Nobody hand-rolls a second copy of the wording.
    for (const f of MODEL_PROSE) expect(read(f)).not.toContain('AI-DRAFTED');
  });
});
