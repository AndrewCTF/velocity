"""AISStream message normalization (app.routes.ais._normalize).

Guards the trust boundary: a malformed MMSI must skip the single message, not
raise out of the websocket async-for and tear down the shared upstream socket
for every connected client.
"""

from __future__ import annotations

import json

from app.routes import ais


def _msg(mmsi: object) -> str:
    return json.dumps(
        {
            "MessageType": "PositionReport",
            "MetaData": {
                "MMSI": mmsi,
                "latitude": 50.0,
                "longitude": 10.0,
                "ShipName": "TESTBOAT",
            },
            "Message": {"PositionReport": {"Sog": 10, "Cog": 90, "TrueHeading": 88}},
        }
    )


def test_normalize_valid_mmsi_yields_vessel() -> None:
    out = ais._normalize(_msg(123456789))
    assert out is not None
    assert json.loads(out)["id"] == "vessel:123456789"


def test_normalize_malformed_mmsi_skips_message_not_raises() -> None:
    # Non-numeric MMSI: skip this one message (return None), never raise.
    assert ais._normalize(_msg("NOT-A-NUMBER")) is None
    # A None MMSI is already dropped by the presence check.
    assert ais._normalize(_msg(None)) is None
