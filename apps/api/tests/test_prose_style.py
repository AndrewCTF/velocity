"""Guard: dashboard-facing model prose is written in the house style.

Operator decision 2026-07-15. The dashboard renders model prose verbatim
(selection brief, pattern-of-life, watch-officer elaboration, country brief,
news analysis). Static UI copy was rewritten to drop em dashes and marketing
register; an unconstrained model re-introduces both within a few sentences, so
the constraint has to live in the prompt, not just in the .tsx strings.

A failure here means either the style rider was dropped from a prompt that
reaches the dashboard, or a new prompt was added without it.
"""

from __future__ import annotations

import inspect

from app import llm
from app.intel import country_profile
from app.news import analyze, brief, verify
from app.routes import ai_selection, intel, watch_officer

EM_DASH = "—"


def test_prose_style_forbids_em_dashes_and_hype() -> None:
    style = llm.PROSE_STYLE
    assert "em dash" in style.lower()
    # The rider must not itself model the punctuation it bans.
    assert EM_DASH not in style
    assert "marketing" in style.lower()


def test_with_prose_style_appends_last_and_is_additive() -> None:
    base = "You are an analyst. Return STRICT JSON and nothing else."
    out = llm.with_prose_style(base)
    # Caller's format contract survives verbatim...
    assert base in out
    # ...and is stated BEFORE the rider, so it wins on any conflict.
    assert out.index(base) < out.index(llm.PROSE_STYLE)
    assert out.endswith(llm.PROSE_STYLE)


def test_with_prose_style_is_idempotent_in_shape() -> None:
    once = llm.with_prose_style("Base.")
    assert once.count(llm.PROSE_STYLE) == 1


def test_static_analyst_prompts_carry_the_style_rider() -> None:
    """Module-level prompt constants that are handed to the model as-is."""
    assert llm.PROSE_STYLE in intel._NARRATIVE_SYSTEM


def test_prompt_constants_contain_no_em_dashes() -> None:
    """The prompts must not demonstrate the punctuation they ban.

    A model copies the register of its instructions; an em dash in the system
    prompt is a worked example of the thing we are trying to stop.
    """
    offenders: list[str] = []
    checks = {
        "intel._NARRATIVE_SYSTEM": intel._NARRATIVE_SYSTEM,
        "country_profile._BRIEF_SYS": country_profile._BRIEF_SYS,
    }
    for name, text in checks.items():
        if EM_DASH in text:
            offenders.append(name)
    assert offenders == [], f"em dash in prompt constant(s): {offenders}"


def test_dashboard_prompt_sites_route_through_with_prose_style() -> None:
    """Every prose-to-dashboard chat call applies the rider at its call site.

    Source-level check on purpose: these prompts are built inline from request
    data, so there is no constant to assert against. This is what catches a new
    brief route that forgets the rider.
    """
    sites = {
        "ai_selection": ai_selection,
        "watch_officer": watch_officer,
        "country_profile": country_profile,
    }
    for name, mod in sites.items():
        src = inspect.getsource(mod)
        assert "with_prose_style" in src, f"{name} builds dashboard prose without the style rider"


def test_news_prompts_apply_style_before_the_injection_guard() -> None:
    """Style rider must not displace the prompt-injection boundary.

    _INJECTION_GUARD is a security control and stays the LAST thing the model
    reads, so untrusted fenced content cannot be followed by anything that
    dilutes it. Style is inserted before it, never after.
    """
    src = inspect.getsource(analyze)
    assert "with_prose_style" in src
    # No call site may append the guard before the rider.
    assert "_INJECTION_GUARD)" not in src.replace("llm.with_prose_style(", "")
    for line in src.splitlines():
        if "_INJECTION_GUARD" in line and "with_prose_style" in line:
            assert line.index("with_prose_style") < line.index("_INJECTION_GUARD"), (
                f"style rider must precede the injection guard: {line.strip()}"
            )


def test_news_verify_prompts_end_with_injection_guard() -> None:
    """verify.py's verifier + repair prompts, and brief.py's synthesis prompt,
    apply the style rider before appending _INJECTION_GUARD, same ordering the
    edition builder itself uses (see the analyze.py check above).

    Source-level check on purpose: both system strings are built inline at the
    call site from module constants, so there is no rendered string to import
    and assert against.
    """
    for mod in (verify, brief):
        src = inspect.getsource(mod)
        assert "with_prose_style" in src, f"{mod.__name__} builds a prompt without the style rider"
        assert "_INJECTION_GUARD" in src, f"{mod.__name__} builds a prompt without the injection guard"
        # No call site may append the guard before the rider.
        assert "_INJECTION_GUARD)" not in src.replace("with_prose_style(", ""), (
            f"{mod.__name__}: something appended after the injection guard"
        )
        for line in src.splitlines():
            if "_INJECTION_GUARD" in line and "with_prose_style" in line:
                assert line.index("with_prose_style") < line.index("_INJECTION_GUARD"), (
                    f"{mod.__name__}: style rider must precede the injection guard: {line.strip()}"
                )
