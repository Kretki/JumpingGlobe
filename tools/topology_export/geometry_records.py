"""Turn GPML features with line, point or topological-line geometry into exportable records."""

from __future__ import annotations

from dataclasses import dataclass, field

# Element is imported for type hints only; all parsing goes through defusedxml.
from xml.etree.ElementTree import Element  # nosec B405

from gpml_to_geojson import GML_NAMESPACE, GPML_NAMESPACE
from topology_export import gpml_elements
from topology_export.section_refs import SectionRef, read_sections

GEOMETRY_PROPERTIES = ("centerLineOf", "unclassifiedGeometry", "outlineOf", "averageSampleSitePosition", "position")
COORDINATE_DECIMALS = 4


@dataclass
class GeometryRecord:
    """One geometry property of one feature, with the feature attributes the client needs.

    Attributes:
        identity: gpml:identity of the feature.
        property_name: Geometry property (local name).
        attributes: Feature attributes (type, name, lifetime, plates, method, polarity).
        geometry_kind: ``line``, ``point`` or ``topoline``.
        coordinates: Flat [lon, lat, lon, lat, ...] in degrees (line/point).
        section_refs: Sections of a topological line (topoline).
    """

    identity: str
    property_name: str
    attributes: dict[str, object]
    geometry_kind: str
    coordinates: list[float] = field(default_factory=list)
    section_refs: list[SectionRef] = field(default_factory=list)


def flat_lon_lat(position_text: str) -> list[float]:
    """Convert GML ``lat lon lat lon ...`` text to a flat lon/lat list.

    Usage:
        gml:posList and gml:pos values.

    Args:
        position_text: Whitespace-separated numbers, latitude first.

    Returns:
        Flat [lon, lat, ...] rounded to 4 decimals (about 10 m); [] when malformed.
    """
    try:
        coordinate_values = [float(value_text) for value_text in position_text.split()]
    except ValueError:
        return []
    flat_values: list[float] = []
    for value_idx in range(0, len(coordinate_values) - 1, 2):
        flat_values.append(round(coordinate_values[value_idx + 1], COORDINATE_DECIMALS))
        flat_values.append(round(coordinate_values[value_idx], COORDINATE_DECIMALS))
    return flat_values


def feature_attributes(feature_element: Element) -> dict[str, object]:
    """Collect the attributes shared by all geometries of a feature.

    Usage:
        Once per geometry feature.

    Args:
        feature_element: GPML feature element.

    Returns:
        Dictionary with ``type``, ``name``, ``begin``, ``end``, ``plateId``, ``method``
        and, when present, ``left``, ``right``, ``importAge``, ``polarity``.
    """
    begin_age, end_age = gpml_elements.feature_lifetime(feature_element)
    attributes: dict[str, object] = {
        "type": gpml_elements.local_name(feature_element.tag),
        "name": gpml_elements.feature_name(feature_element),
        "begin": begin_age,
        "end": end_age,
        "plateId": gpml_elements.reconstruction_plate(feature_element),
        "method": gpml_elements.reconstruction_method(feature_element),
    }
    optional_values = {
        "left": gpml_elements.side_plate(feature_element, "leftPlate"),
        "right": gpml_elements.side_plate(feature_element, "rightPlate"),
        "importAge": gpml_elements.import_age(feature_element),
        "polarity": gpml_elements.subduction_polarity(feature_element),
    }
    attributes.update({key_name: key_value for key_name, key_value in optional_values.items() if key_value is not None})
    return attributes


def property_record(identity: str, property_element: Element, attributes: dict[str, object]) -> GeometryRecord | None:
    """Build the record of one geometry property.

    Usage:
        Called for each geometry property of a feature.

    Args:
        identity: Feature identity.
        property_element: The geometry property element (e.g. gpml:centerLineOf).
        attributes: Feature attributes from feature_attributes.

    Returns:
        A line, point or topoline record, or None when the property has no usable geometry.
    """
    property_name = gpml_elements.local_name(property_element.tag)
    topological_line = property_element.find(f".//{GPML_NAMESPACE}TopologicalLine")
    if topological_line is not None:
        section_refs = read_sections(topological_line)
        if not section_refs:
            return None
        return GeometryRecord(identity, property_name, attributes, "topoline", section_refs=section_refs)
    position_list = property_element.find(f".//{GML_NAMESPACE}posList")
    if position_list is not None and position_list.text:
        line_coordinates = flat_lon_lat(position_list.text)
        if len(line_coordinates) < 4:
            return None
        return GeometryRecord(identity, property_name, attributes, "line", line_coordinates)
    point_position = property_element.find(f".//{GML_NAMESPACE}pos")
    if point_position is not None and point_position.text:
        point_coordinates = flat_lon_lat(point_position.text)
        if len(point_coordinates) != 2:
            return None
        return GeometryRecord(identity, property_name, attributes, "point", point_coordinates)
    return None


def geometry_records(feature_element: Element) -> list[GeometryRecord]:
    """Records for every geometry property of a feature.

    Usage:
        Called by the model builder for each non-topology feature.

    Args:
        feature_element: GPML feature element.

    Returns:
        One record per usable geometry property (often exactly one); [] without identity.
    """
    identity = gpml_elements.element_text(feature_element, f"{GPML_NAMESPACE}identity")
    if not identity:
        return []
    attributes = feature_attributes(feature_element)
    record_list: list[GeometryRecord] = []
    for property_name in GEOMETRY_PROPERTIES:
        for property_element in feature_element.findall(f"{GPML_NAMESPACE}{property_name}"):
            geometry_record = property_record(identity, property_element, attributes)
            if geometry_record is not None:
                record_list.append(geometry_record)
    return record_list
