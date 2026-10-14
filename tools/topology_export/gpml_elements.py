"""Read scalar properties (names, lifetimes, plate ids, polarity) from GPlates GPML feature elements."""

from __future__ import annotations

# Element is imported for type hints only; all parsing goes through defusedxml.
from xml.etree.ElementTree import Element  # nosec B405

from gpml_to_geojson import DISTANT_PAST_MA, GML_NAMESPACE, GPML_NAMESPACE, parse_time_position

PLATE_ID_PATH = f"{GPML_NAMESPACE}reconstructionPlateId//{GPML_NAMESPACE}value"
DEFAULT_METHOD = "ByPlateId"


def local_name(element_tag: str) -> str:
    """Strip the XML namespace from a tag.

    Usage:
        Feature type of a GPML feature element, e.g. ``SubductionZone``.

    Args:
        element_tag: Tag such as ``{http://www.gplates.org/gplates}SubductionZone``.

    Returns:
        The local part of the tag.
    """
    return element_tag.rsplit("}", 1)[-1]


def element_text(parent_element: Element, element_path: str) -> str:
    """Return the stripped text of the first element at a path.

    Usage:
        Simple text properties (names, plate ids, enumerations).

    Args:
        parent_element: Element to search below.
        element_path: ElementTree path (namespaced).

    Returns:
        The text, or "" when the element or its text is missing.
    """
    found_element = parent_element.find(element_path)
    if found_element is None or found_element.text is None:
        return ""
    return found_element.text.strip()


def optional_int(text_value: str) -> int | None:
    """Parse an integer that may be written as a float or be missing.

    Usage:
        Plate ids (GPML sometimes writes ``503.0``).

    Args:
        text_value: Text from the GPML file.

    Returns:
        The integer, or None for empty or malformed text.
    """
    try:
        return int(float(text_value)) if text_value else None
    except ValueError:
        return None


def period_ages(time_period: Element | None) -> tuple[float, float]:
    """Read the begin and end ages of a gml:TimePeriod.

    Usage:
        Feature lifetimes and topology time windows.

    Args:
        time_period: gml:TimePeriod element, or None.

    Returns:
        Tuple (begin age, end age) in Ma; ``distantPast`` is 1e6, ``distantFuture`` 0.
    """
    if time_period is None:
        return DISTANT_PAST_MA, 0.0
    begin_element = time_period.find(f"{GML_NAMESPACE}begin")
    end_element = time_period.find(f"{GML_NAMESPACE}end")
    return parse_time_position(begin_element, DISTANT_PAST_MA), parse_time_position(end_element, 0.0)


def feature_lifetime(feature_element: Element) -> tuple[float, float]:
    """Read a feature's gml:validTime.

    Usage:
        Every exported feature and topology.

    Args:
        feature_element: GPML feature element.

    Returns:
        Tuple (begin age, end age) in Ma.
    """
    return period_ages(feature_element.find(f"{GML_NAMESPACE}validTime/{GML_NAMESPACE}TimePeriod"))


def feature_name(feature_element: Element) -> str:
    """Read a feature's gml:name.

    Usage:
        Labels of plates and boundaries.

    Args:
        feature_element: GPML feature element.

    Returns:
        The name, or "".
    """
    return element_text(feature_element, f"{GML_NAMESPACE}name")


def reconstruction_plate(feature_element: Element) -> int:
    """Read a feature's constant reconstruction plate id.

    Usage:
        Plates of geometry features and topologies.

    Args:
        feature_element: GPML feature element.

    Returns:
        The plate id, or 0 when missing.
    """
    return optional_int(element_text(feature_element, PLATE_ID_PATH)) or 0


def side_plate(feature_element: Element, side_tag: str) -> int | None:
    """Read gpml:leftPlate or gpml:rightPlate.

    Usage:
        Half-stage reconstruction of ridges and relative motion across boundaries.

    Args:
        feature_element: GPML feature element.
        side_tag: ``leftPlate`` or ``rightPlate``.

    Returns:
        The plate id, or None when missing or 0.
    """
    return optional_int(element_text(feature_element, f"{GPML_NAMESPACE}{side_tag}")) or None


def import_age(feature_element: Element) -> float | None:
    """Read gpml:geometryImportTime (age at which the geometry was digitised).

    Usage:
        HalfStageRotationVersion3 reconstruction.

    Args:
        feature_element: GPML feature element.

    Returns:
        Age in Ma, or None when missing.
    """
    import_element = feature_element.find(f"{GPML_NAMESPACE}geometryImportTime")
    return parse_time_position(import_element, -1.0) if import_element is not None else None


def reconstruction_method(feature_element: Element) -> str:
    """Read gpml:reconstructionMethod.

    Usage:
        Choose plate-id or half-stage reconstruction.

    Args:
        feature_element: GPML feature element.

    Returns:
        Method name, ``ByPlateId`` by default.
    """
    return element_text(feature_element, f"{GPML_NAMESPACE}reconstructionMethod") or DEFAULT_METHOD


def subduction_polarity(feature_element: Element) -> str | None:
    """Read gpml:subductionPolarity (side of the overriding plate along the line).

    Usage:
        Direction of the subduction-zone teeth.

    Args:
        feature_element: GPML feature element.

    Returns:
        ``Left`` or ``Right``, or None when missing or ``Unknown``.
    """
    polarity_text = element_text(feature_element, f"{GPML_NAMESPACE}subductionPolarity//{GPML_NAMESPACE}value")
    return polarity_text if polarity_text in ("Left", "Right") else None
