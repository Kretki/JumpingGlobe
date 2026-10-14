"""Read topological closed plate polygons (constant or time-windowed boundaries) from GPML."""

from __future__ import annotations

from dataclasses import dataclass

# Element is imported for type hints only; all parsing goes through defusedxml.
from xml.etree.ElementTree import Element  # nosec B405

from gpml_to_geojson import GML_NAMESPACE, GPML_NAMESPACE
from topology_export import gpml_elements
from topology_export.section_refs import SectionRef, read_sections

_SECTIONS_PATH = (
    f".//{GPML_NAMESPACE}TopologicalPolygon/{GPML_NAMESPACE}exterior/{GPML_NAMESPACE}TopologicalSections"
)


@dataclass(frozen=True)
class SectionWindow:
    """Section list valid during an age interval.

    Attributes:
        begin_age: Older bound in Ma.
        end_age: Younger bound in Ma.
        section_refs: Sections in traversal order.
    """

    begin_age: float
    end_age: float
    section_refs: list[SectionRef]


@dataclass(frozen=True)
class TopologyRecord:
    """One topological plate polygon feature.

    Attributes:
        plate_id: Reconstruction plate id of the plate.
        name: Feature name.
        begin_age: Feature valid time begin (Ma).
        end_age: Feature valid time end (Ma).
        windows: Section lists by time window (one window for constant boundaries).
    """

    plate_id: int
    name: str
    begin_age: float
    end_age: float
    windows: list[SectionWindow]


def window_sections(window_value: Element) -> list[SectionRef]:
    """Sections of the topological polygon inside an element.

    Usage:
        Constant boundaries and each time window.

    Args:
        window_value: Element containing one gpml:TopologicalPolygon.

    Returns:
        Section references, [] when the polygon is missing.
    """
    sections_element = window_value.find(_SECTIONS_PATH)
    return read_sections(sections_element) if sections_element is not None else []


def boundary_windows(boundary_element: Element, lifetime: tuple[float, float]) -> list[SectionWindow]:
    """Section windows of a gpml:boundary property.

    Usage:
        Called once per topology feature.

    Args:
        boundary_element: The gpml:boundary element.
        lifetime: Feature (begin, end) ages, used for constant boundaries.

    Returns:
        Windows with at least one section.
    """
    piecewise = boundary_element.find(f"{GPML_NAMESPACE}PiecewiseAggregation")
    if piecewise is None:
        section_refs = window_sections(boundary_element)
        return [SectionWindow(lifetime[0], lifetime[1], section_refs)] if section_refs else []
    window_list: list[SectionWindow] = []
    for time_window in piecewise.iter(f"{GPML_NAMESPACE}TimeWindow"):
        begin_age, end_age = gpml_elements.period_ages(
            time_window.find(f"{GPML_NAMESPACE}validTime/{GML_NAMESPACE}TimePeriod")
        )
        section_refs = window_sections(time_window)
        if section_refs:
            window_list.append(SectionWindow(begin_age, end_age, section_refs))
    return window_list


def topology_record(feature_element: Element) -> TopologyRecord | None:
    """Parse a feature as a topological plate polygon.

    Usage:
        Called for every feature; non-topologies return None.

    Args:
        feature_element: GPML feature element.

    Returns:
        The record, or None when the feature has no topological polygon boundary.
    """
    boundary_element = feature_element.find(f"{GPML_NAMESPACE}boundary")
    if boundary_element is None:
        return None
    lifetime = gpml_elements.feature_lifetime(feature_element)
    windows = boundary_windows(boundary_element, lifetime)
    if not windows:
        return None
    return TopologyRecord(
        plate_id=gpml_elements.reconstruction_plate(feature_element),
        name=gpml_elements.feature_name(feature_element),
        begin_age=lifetime[0],
        end_age=lifetime[1],
        windows=windows,
    )
