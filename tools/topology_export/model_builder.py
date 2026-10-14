"""Assemble geometry and topology records into the compact topology model served to the client."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Element is imported for type hints only; all parsing goes through defusedxml.
from xml.etree.ElementTree import Element  # nosec B405

from topology_export.geometry_records import GeometryRecord, geometry_records
from topology_export.section_refs import SectionRef
from topology_export.topology_records import TopologyRecord, topology_record

MODEL_VERSION = 1
RecordKey = tuple[str, str]
"""(feature identity, geometry property name)."""


@dataclass
class LinkState:
    """Records exported so far while linking sections.

    Attributes:
        index_by_key: Record index of every exported (identity, property) pair.
        ordered: Exported records in index order.
    """

    index_by_key: dict[RecordKey, int] = field(default_factory=dict)
    ordered: list[GeometryRecord] = field(default_factory=list)


class TopologyModelBuilder:
    """Collects features from any number of GPML files, then links topology sections to geometries."""

    def __init__(self) -> None:
        """Create an empty builder.

        Usage:
            ``builder = TopologyModelBuilder()``; call add_feature() per feature, then build().

        Returns:
            None.
        """
        self._records: dict[RecordKey, GeometryRecord] = {}
        self._topologies: list[TopologyRecord] = []
        self.missing_sections = 0

    def add_feature(self, feature_element: Element) -> None:
        """Register one GPML feature (topology or geometry feature).

        Usage:
            Called for every gml:featureMember child, in file order.

        Args:
            feature_element: GPML feature element.

        Returns:
            None; the first record wins when an identity/property pair repeats.
        """
        topology = topology_record(feature_element)
        if topology is not None:
            self._topologies.append(topology)
            return
        for geometry_record in geometry_records(feature_element):
            self._records.setdefault((geometry_record.identity, geometry_record.property_name), geometry_record)

    def _section_index(self, section_ref: SectionRef, link_state: LinkState) -> int | None:
        """Index of a section's geometry record, adding the record (and its own sections) on first use.

        Usage:
            Linking topology sections; only referenced records are exported.

        Args:
            section_ref: Section to resolve.
            link_state: Exported records so far (extended in place).

        Returns:
            The record index, or None when the target is not in any loaded file.
        """
        record_key = (section_ref.target_identity, section_ref.target_property)
        if record_key in link_state.index_by_key:
            return link_state.index_by_key[record_key]
        geometry_record = self._records.get(record_key)
        if geometry_record is None:
            self.missing_sections += 1
            return None
        link_state.index_by_key[record_key] = len(link_state.ordered)
        link_state.ordered.append(geometry_record)
        for nested_ref in geometry_record.section_refs:
            self._section_index(nested_ref, link_state)
        return link_state.index_by_key[record_key]

    def _linked_sections(self, section_refs: list[SectionRef], link_state: LinkState) -> list[list[int]]:
        """Convert section references to ``[record index, reversed 0/1]`` pairs.

        Usage:
            Topology windows and topological lines.

        Args:
            section_refs: Sections in traversal order.
            link_state: Exported records so far (extended in place).

        Returns:
            Linked sections; sections whose target is missing are dropped (as GPlates does).
        """
        linked: list[list[int]] = []
        for section_ref in section_refs:
            record_index = self._section_index(section_ref, link_state)
            if record_index is not None:
                linked.append([record_index, 1 if section_ref.is_reversed else 0])
        return linked

    def _feature_json(self, geometry_record: GeometryRecord, link_state: LinkState) -> dict[str, Any]:
        """JSON object of one exported geometry record.

        Usage:
            build(), once per exported record.

        Args:
            geometry_record: Record to encode.
            link_state: Exported records so far (extended in place).

        Returns:
            Attributes plus ``kind`` and ``coords`` or ``sections``.
        """
        feature_json: dict[str, Any] = {**geometry_record.attributes, "kind": geometry_record.geometry_kind}
        if geometry_record.geometry_kind == "topoline":
            feature_json["sections"] = self._linked_sections(geometry_record.section_refs, link_state)
        else:
            feature_json["coords"] = geometry_record.coordinates
        return feature_json

    def _topology_json(self, topology: TopologyRecord, link_state: LinkState) -> dict[str, Any]:
        """JSON object of one topology.

        Usage:
            build(), once per topology.

        Args:
            topology: Topology to encode.
            link_state: Exported records so far (extended in place).

        Returns:
            ``{"plateId", "name", "begin", "end", "windows": [{"begin", "end", "sections"}]}``.
        """
        return {
            "plateId": topology.plate_id,
            "name": topology.name,
            "begin": topology.begin_age,
            "end": topology.end_age,
            "windows": [
                {
                    "begin": section_window.begin_age,
                    "end": section_window.end_age,
                    "sections": self._linked_sections(section_window.section_refs, link_state),
                }
                for section_window in topology.windows
            ],
        }

    def build(self) -> dict[str, Any]:
        """Link all topologies to their section geometries.

        Usage:
            After every file was added.

        Returns:
            ``{"version", "features", "topologies"}``; only features referenced by some
            topology (directly or through a topological line) are included.
        """
        link_state = LinkState()
        topology_list = [self._topology_json(topology, link_state) for topology in self._topologies]
        feature_list: list[dict[str, Any]] = []
        record_idx = 0
        # Encoding a topological line can export further records, so the list may grow while iterating.
        while record_idx < len(link_state.ordered):
            feature_list.append(self._feature_json(link_state.ordered[record_idx], link_state))
            record_idx += 1
        return {"version": MODEL_VERSION, "features": feature_list, "topologies": topology_list}
