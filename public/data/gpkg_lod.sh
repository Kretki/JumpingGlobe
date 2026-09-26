# 1. stay in shapefile / GPKG — never materialize 2 GiB GeoJSON
ogr2ogr -f GPKG -t_srs EPSG:4326 \
  -nlt MULTIPOLYGON -lco SPATIAL_INDEX=YES \
  land.gpkg land_polygons.shp

# 2. far-field LOD (globe)
ogr2ogr -f GPKG land_lod0.gpkg land.gpkg \
  -simplify 0.15          # degrees; tune
# mid
ogr2ogr -f GPKG land_lod1.gpkg land.gpkg -simplify 0.03
# near-coast, still not full OSM
ogr2ogr -f GPKG land_lod2.gpkg land.gpkg -simplify 0.005

# 3. optional: FlatGeobuf if you want seekable rings
ogr2ogr -f FlatGeobuf land_lod1.fgb land_lod1.gpkg
