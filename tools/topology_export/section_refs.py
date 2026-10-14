"""Read topological section references (line and point sections) from GPML topology elements."""

from __future__ import annotations

from dataclasses import dataclass

# Element is imported for type hints only; all parsing goes through defusedxml.
from xml.etree.ElementTree import Element  # nosec B405

from gpml_to_geojson import GPML_NAMESPACE
from topology_export.gpml_elements import element_text, local_name

_LINE_SECTION = "TopologicalLineSection"
_POINT_SECTION = "TopologicalPoint"


@dataclass(frozen=True)
class SectionRef:
    """One section of a topology before feature ids are mapped to record indices.

    Attributes:
        target_identity: gpml:identity of the referenced feature.
        target_property: Referenced geometry property (local name, e.g. ``centerLineOf``).
        is_reversed: The section is traversed against its geometry's direction.
    """

    target_identity: str
    target_property: str
    is_reversed: bool


def read_section(section_element: Element) -> SectionRef | None:
    """Parse one gpml:section child (a line or point section).

    Usage:
        Called for every section of a topological polygon or line.

    Args:
        section_element: The gpml:section element.

    Returns:
        The reference, or None for unknown section kinds or missing targets.
    """
    section_body = next(iter(section_element), None)
    if section_body is None or local_name(section_body.tag) not in (_LINE_SECTION, _POINT_SECTION):
        return None
    delegate_path = f"{GPML_NAMESPACE}sourceGeometry/{GPML_NAMESPACE}PropertyDelegate"
    target_identity = element_text(section_body, f"{delegate_path}/{GPML_NAMESPACE}targetFeature")
    target_property = element_text(section_body, f"{delegate_path}/{GPML_NAMESPACE}targetProperty")
    if not target_identity or not target_property:
        return None
    reverse_text = element_text(section_body, f"{GPML_NAMESPACE}reverseOrder")
    return SectionRef(target_identity, target_property.split(":")[-1], reverse_text == "true")


def read_sections(sections_parent: Element) -> list[SectionRef]:
    """Parse the gpml:section children of an element, in order.

    Usage:
        gpml:TopologicalSections (polygons) and gpml:TopologicalLine (lines).

    Args:
        sections_parent: Element whose direct children are gpml:section elements.

    Returns:
        Section references in traversal order; unreadable sections are skipped.
    """
    section_refs: list[SectionRef] = []
    for section_element in sections_parent.findall(f"{GPML_NAMESPACE}section"):
        section_ref = read_section(section_element)
        if section_ref is not None:
            section_refs.append(section_ref)
    return section_refs
