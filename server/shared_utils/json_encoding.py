"""Compact JSON encoding shared by the cached API responses."""

from __future__ import annotations

import json
from typing import Any


def encode_compact_json(json_payload: Any) -> bytes:
    """Serialise a json_payload as compact UTF-8 JSON.

    Usage:
        Encode every API body once so cached responses skip re-encoding.

    Args:
        json_payload: JSON-serialisable object.

    Returns:
        UTF-8 bytes without insignificant whitespace.
    """
    return json.dumps(json_payload, separators=(",", ":")).encode("utf-8")
