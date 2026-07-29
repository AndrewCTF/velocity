"""Named questions, answered - the one surface that is not a map.

Everything else in this console shows you data and leaves the conclusion to you.
These routes do the opposite: one question, one word, with the rule and the
evidence age attached. See app/intel/answers.py for why that distinction is the
whole point.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.intel import answers as answers_intel

router = APIRouter(tags=["answers"])


@router.get("/api/answers")
async def list_answers() -> dict[str, Any]:
    """Every answer we can currently give, verdicts included."""
    items = await answers_intel.all_answers()
    return {"answers": items, "count": len(items)}


@router.get("/api/answers/{answer_id}")
async def get_answer(answer_id: str) -> dict[str, Any]:
    """One answer. 404 only for a name we have never heard of.

    A question we KNOW but cannot currently answer returns 200 with an `unknown`
    verdict and the reason, because "we do not have enough history yet" is a
    real answer and an operator needs to see it. Collapsing that into an error
    would hide the most honest thing this endpoint says.
    """
    if answer_id == "aircraft-coverage":
        return (await answers_intel.coverage_answer()).to_dict()
    ans = await answers_intel.chokepoint_answer(answer_id)
    if ans.verdict == answers_intel.UNKNOWN and "No chokepoint with that name" in ans.detail:
        raise HTTPException(status_code=404, detail=ans.detail)
    return ans.to_dict()
