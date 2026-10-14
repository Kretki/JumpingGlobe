#!/usr/bin/env python3
"""
Export GPlates topological plate polygons and their boundary sections to compact JSON.

  gpml_topologies.py <out.json> <in.gpml|in.gpmlz> [<in.gpml> ...]

The output holds every TopologicalClosedPlateBoundary (plate id, name, lifetime,
section lists per time window) and the geometry features its sections reference
(mid-ocean ridges, subduction zones, transforms, ... with plate ids, reconstruction
method, left/right plates and subduction polarity), in present-day coordinates.
The globe resolves the plate polygons and boundaries from it at any age
(src/plates/topology/).

GPML is XML; it is parsed with defusedxml so entity-expansion and external-entity
attacks are rejected.
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

from defusedxml.ElementTree import iterparse
from gpml_to_geojson import GML_NAMESPACE
from topology_export.model_builder import TopologyModelBuilder


def add_gpml_file(source_path: str, model_builder: TopologyModelBuilder) -> int:
    """Stream one GPML/GPMLZ file into the builder.

    Usage:
        Called for each input file, in the given order.

    Args:
        source_path: Input path; a name ending in ``z`` is read as gzip.
        model_builder: Builder to add features to.

    Returns:
        Number of features read.
    """
    open_function = gzip.open if source_path.endswith("z") else open
    feature_count = 0
    with open_function(source_path, "rb") as source_stream:
        for _, xml_element in iterparse(source_stream, events=("end",)):
            if xml_element.tag != f"{GML_NAMESPACE}featureMember":
                continue
            feature_element = next(iter(xml_element), None)
            if feature_element is not None:
                model_builder.add_feature(feature_element)
                feature_count += 1
            xml_element.clear()
    return feature_count


def export_topologies(output_path: str, source_paths: list[str]) -> dict[str, int]:
    """Export the topology model of several GPML files.

    Usage:
        ``export_topologies("cao_topologies.json", ["250-0_plate_boundaries.gpml", ...])``.

    Args:
        output_path: JSON file to write (overwritten).
        source_paths: GPML/GPMLZ inputs; features may reference features in any of them.

    Returns:
        Counts: features read, exported features, topologies and dropped missing sections.
    """
    model_builder = TopologyModelBuilder()
    features_read = sum(add_gpml_file(source_path, model_builder) for source_path in source_paths)
    topology_model = model_builder.build()
    Path(output_path).write_text(json.dumps(topology_model, separators=(",", ":")), encoding="utf-8")
    return {
        "read": features_read,
        "features": len(topology_model["features"]),
        "topologies": len(topology_model["topologies"]),
        "missing": model_builder.missing_sections,
    }


def cli_main(argument_list: list[str]) -> int:
    """Command-line entry point.

    Usage:
        ``gpml_topologies.py <out.json> <in.gpml> [...]``.

    Args:
        argument_list: ``sys.argv``.

    Returns:
        Process exit status (0 on success).
    """
    if len(argument_list) < 3:
        sys.exit(__doc__)
    export_counts = export_topologies(argument_list[1], argument_list[2:])
    print(
        f"{export_counts['read']} features read -> {export_counts['topologies']} topologies, "
        f"{export_counts['features']} section features ({export_counts['missing']} missing sections dropped)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(cli_main(sys.argv))
