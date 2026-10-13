"""Multiprocessing worker: plate-tag one FID range of the land layer into its own GeoPackage."""

from __future__ import annotations

from dataclasses import dataclass

from osgeo import ogr

from plate_tagging.geometry_filters import DISTANT_PAST_MA, LAYER_NAME, envelope_area, polygonal_part
from plate_tagging.output_layer import create_plate_layer, write_piece
from plate_tagging.piece_assigner import assign_pieces
from plate_tagging.static_index import StaticPolygonIndex

# One index per worker process, loaded on its first task.
_PROCESS_INDEX: StaticPolygonIndex | None = None


@dataclass(frozen=True)
class ChunkTask:
    """One unit of work: land features with lower_fid <= fid < upper_fid."""

    land_path: str
    static_path: str
    lower_fid: int
    upper_fid: int
    output_path: str


def process_index(static_path: str) -> StaticPolygonIndex:
    """Return this process's static-polygon index, loading it once.

    Usage:
        First call in every worker task.

    Args:
        static_path: Static-polygon GeoPackage.

    Returns:
        The cached index.
    """
    global _PROCESS_INDEX
    if _PROCESS_INDEX is None:
        _PROCESS_INDEX = StaticPolygonIndex.from_file(static_path)
    return _PROCESS_INDEX


def source_area(land_feature: ogr.Feature, land_geometry: ogr.Geometry, has_source_area: bool) -> float:
    """Envelope area of the ORIGINAL land polygon.

    Usage:
        Re-tagging an already tagged file keeps the original polygon's area.

    Args:
        land_feature: Input feature.
        land_geometry: Its polygonal geometry.
        has_source_area: Whether the input layer has a src_env_area field.

    Returns:
        Area in deg².
    """
    if has_source_area and land_feature.GetField("src_env_area") is not None:
        return float(land_feature.GetField("src_env_area"))
    return envelope_area(land_geometry.GetEnvelope())


def tag_chunk(chunk_task: ChunkTask) -> tuple[int, int]:
    """Plate-tag one FID range of the land layer.

    Usage:
        ``pool.imap_unordered(tag_chunk, tasks)``.

    Args:
        chunk_task: Input/output paths and the FID range.

    Returns:
        Tuple (land features read, pieces written).
    """
    static_index = process_index(chunk_task.static_path)
    land_source = ogr.Open(chunk_task.land_path)
    land_layer = land_source.GetLayer(LAYER_NAME)
    land_layer.SetAttributeFilter(f"fid >= {int(chunk_task.lower_fid)} AND fid < {int(chunk_task.upper_fid)}")
    has_source_area = land_layer.GetLayerDefn().GetFieldIndex("src_env_area") >= 0

    datasource, output_layer = create_plate_layer(chunk_task.output_path, spatial_index=False)
    features_read = pieces_written = 0
    datasource.StartTransaction()
    for land_feature in land_layer:
        land_geometry = polygonal_part(land_feature.GetGeometryRef())
        if land_geometry is None:
            continue
        features_read += 1
        original_area = source_area(land_feature, land_geometry, has_source_area)
        for entry_idx, land_piece in assign_pieces(land_geometry, static_index):
            if static_index.static_entries:
                static_entry = static_index.static_entries[entry_idx]
                plate_values = (static_entry.plate_id, static_entry.from_age_ma, static_entry.to_age_ma)
            else:
                plate_values = (0, DISTANT_PAST_MA, 0.0)
            write_piece(output_layer, land_piece, plate_values, original_area)
            pieces_written += 1
    datasource.CommitTransaction()
    datasource = None
    return features_read, pieces_written
