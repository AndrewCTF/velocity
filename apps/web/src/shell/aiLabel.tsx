// The label that must accompany machine-generated prose wherever a reader
// could mistake it for an observation.
//
// apps/api/app/intel/case_export.py already enforces exactly this on the
// evidentiary path: a narrative cannot reach an exported case document without
// it, and tests/test_case_export.py pins both the present and absent cases. The
// surfaces an analyst actually reads all day — the entity panel's AI
// assessment, the watch-officer brief, the country brief, the intel panel —
// carried no such marker at all. That is the wrong way round: the document gets
// read once by someone who knows it is a draft, and the panel gets read fifty
// times a day by someone triaging.
//
// The string is duplicated across the language boundary on purpose, and
// apps/api/tests/test_ai_label_parity.py fails if the two ever drift, the same
// way test_readme_claims.py holds the countable claims to their source.
export const AI_LABEL =
  'AI-DRAFTED · UNVERIFIED. This text was machine-generated as a drafting ' +
  'aid; a human must verify every statement against the cited evidence ' +
  'before relying on it. Not itself evidence.';

/** The marker itself. Muted rather than loud: it is a standing condition of the
 *  text, not an error, and an alarm colour on every AI block trains people to
 *  stop seeing it. */
export function AiLabel({ className = '' }: { className?: string }): JSX.Element {
  return (
    <p
      data-ai-label
      className={`mono text-[10px] leading-[1.5] text-txt-3 border-l-2 border-warn-line pl-1.5 ${className}`}
    >
      {AI_LABEL}
    </p>
  );
}
