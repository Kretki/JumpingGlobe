"""Create, fill and merge the plate-tagged output GeoPackages."""

from __future__ import annotations

import os

from osgeo import ogr, osr

from plate_tagging.geometry_filters import LAYER_NAME

PLATE_FIELDS = (
    ("plate_id", ogr.OFTInteger),
    ("from_age", ogr.OFTReal),
    ("to_age", ogr.OFTReal),
    ("src_env_area", ogr.OFTReal),
)
_AREA_INDEX_SQL = f"CREATE INDEX IF NOT EXISTS idx_{LAYER_NAME}_src_env_area ON {LAYER_NAME}(src_env_area)"


def create_plate_layer(output_path: str, spatial_index: bool) -> tuple[ogr.DataSource, ogr.Layer]:
    """Create a GeoPackage with an empty plate-tagged land layer.

    Usage:
        Chunk outputs (no spatial index) and the final merged file (with one).

    Args:
        output_path: GeoPackage to create (must not exist).
        spatial_index: Whether GDAL builds the R-tree.

    Returns:
        Tuple (datasource, layer); keep the datasource referenced until done.
    """
    gpkg_driver = ogr.GetDriverByName("GPKG")
    datasource = gpkg_driver.CreateDataSource(output_path)
    spatial_ref = osr.SpatialReference()
    spatial_ref.ImportFromEPSG(4326)
    index_option = "SPATIAL_INDEX=YES" if spatial_index else "SPATIAL_INDEX=NO"
    output_layer = datasource.CreateLayer(LAYER_NAME, spatial_ref, ogr.wkbMultiPolygon, options=[index_option])
    for field_name, field_type in PLATE_FIELDS:
        output_layer.CreateField(ogr.FieldDefn(field_name, field_type))
    return datasource, output_layer


def write_piece(
    output_layer: ogr.Layer,
    piece_geometry: ogr.Geometry,
    plate_values: tuple[int, float, float],
    source_area: float,
) -> None:
    """Append one tagged piece to an output layer.

    Usage:
        Called for every assigned piece by the chunk worker.

    Args:
        output_layer: Layer created by create_plate_layer.
        piece_geometry: Land piece geometry.
        plate_values: (plate_id, from_age_ma, to_age_ma).
        source_area: Envelope area (deg²) of the original land polygon.

    Returns:
        None.
    """
    plate_id, from_age_ma, to_age_ma = plate_values
    output_feature = ogr.Feature(output_layer.GetLayerDefn())
    output_feature.SetGeometry(ogr.ForceToMultiPolygon(piece_geometry))
    output_feature.SetField("plate_id", plate_id)
    output_feature.SetField("from_age", from_age_ma)
    output_feature.SetField("to_age", to_age_ma)
    output_feature.SetField("src_env_area", source_area)
    output_layer.CreateFeature(output_feature)


def merge_parts(part_paths: list[str], output_path: str) -> None:
    """Merge chunk GeoPackages into the final indexed output, in the given order.

    Usage:
        Last step of plate_tag.py; an existing output is replaced.

    Args:
        part_paths: Chunk files, in input order.
        output_path: Final GeoPackage.

    Returns:
        None.
    """
    gpkg_driver = ogr.GetDriverByName("GPKG")
    if os.path.exists(output_path):
        gpkg_driver.DeleteDataSource(output_path)
    datasource, output_layer = create_plate_layer(output_path, spatial_index=True)
    datasource.StartTransaction()
    for part_path in part_paths:
        part_source = ogr.Open(part_path)
        for part_feature in part_source.GetLayer(0):
            part_feature.SetFID(-1)
            output_layer.CreateFeature(part_feature)
        part_source = None
    datasource.CommitTransaction()
    datasource.ExecuteSQL(_AREA_INDEX_SQL)
    datasource = None
