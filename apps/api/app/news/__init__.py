"""News debias / fact-check engine.

Scrapes world news from many outlets, then uses :mod:`app.llm` to strip bias
and propaganda, separate verified facts from attributed claims, and fact-check
by cross-source corroboration.

The driving principle: a leader saying "the war will end soon" 38 times is
rhetoric, NOT a fact. The engine flags repeated unfulfilled assertions and
never reports them as fact — a claim becomes a FACT only when >=2 independent
outlets report it AS fact.

Submodules:
  - :mod:`app.news.sources`  — RSS feed definitions + concurrent fetch/parse.
  - :mod:`app.news.store`    — process-local cache of articles + analysis.
  - :mod:`app.news.analyze`  — LLM clustering, debias, and fact-check.
"""

from __future__ import annotations
