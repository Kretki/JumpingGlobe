#!/usr/bin/env bash
# Build the land LOD GeoPackages served by the API from an OSM land-polygons archive.
#
# Usage:
#   gpkg_lod.sh <land-polygons.zip> <dest_dir>
#
# Arguments:
#   land-polygons.zip  OSM "land-polygons-split-4326" style archive containing
#                      <archive name>/land_polygons.shp
#   dest_dir           output directory (lod.json dataDir, e.g. public/data/lods)
#
# Outputs (in dest_dir):
#   land_lod0.gpkg … land_lod5.gpkg   EPSG:4326, layer land_polygons, R-tree index,
#                                     simplified in metres (EPSG:4087) per LOD
#   <lod>_cao_plates.gpkg, cao_static.gpkg, cao_plate_outlines.gpkg
#                                     plate layers via public/external/cao_prep.sh,
#                                     when the Cao et al. 2024 model files are present
#                                     in public/external/cao_rot
#
# Needs: unzip, ogr2ogr (gdal-bin), awk. Temporary files live in dest_dir/.lod_work
# and are removed at the end.
set -euo pipefail

zip_path="${1:?usage: $0 <zip> <dir>}"
dest_dir="${2:?usage: $0 <zip> <dir>}"

[ -f "$zip_path" ] || { printf 'not a zip file: %s\n' "$zip_path" >&2; exit 1; }

zip_base="$(basename -- "$zip_path")"
archive_name="${zip_base%.*}"
dest_dir="${dest_dir%/}"
work_dir="${dest_dir}/.lod_work"

mkdir -p -- "$dest_dir" "$work_dir"
cp -- "$zip_path" "${dest_dir}/${zip_base}"

printf 'Unzip stage\n'
unzip -o -- "${dest_dir}/${zip_base}" -d "$dest_dir" > /dev/null
rm -f -- "${dest_dir:?}/${zip_base:?}"

shapefile="${dest_dir}/${archive_name}/land_polygons.shp"
[ -f "$shapefile" ] || { printf 'missing shapefile: %s\n' "$shapefile" >&2; exit 1; }

printf 'Convert to gpkg stage\n'
ogr2ogr -f GPKG -t_srs EPSG:4326 \
  -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -lco SPATIAL_INDEX=YES \
  "${work_dir}/land.gpkg" "$shapefile" \
  -progress

printf 'Metre master stage (EPSG:4087)\n'
ogr2ogr -f GPKG -t_srs EPSG:4087 \
  -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -lco SPATIAL_INDEX=YES \
  "${work_dir}/land_4087.gpkg" "${work_dir}/land.gpkg" \
  -progress

# EPSG:4087 is plate carrée on WGS84 (1 deg = 111319.490793 m), so an envelope
# area in deg² (what the API's min_area filters on) is m² / DEG2_TO_M2.
DEG2_TO_M2=12392029030.5

# write_lod <lod level> <simplify tolerance m> <min envelope area deg²>
#
# Writes dest_dir/land_lod<level>.gpkg.
# - No -segmentize: the client re-densifies rings geodesically to each LOD's
#   edge budget; pre-segmentized vertices only bloated the files and made
#   earcut produce slivers (the main cause of the slow world load).
# - Coarse LODs drop polygons whose envelope is below half of the smallest
#   min_area the client ever requests for that LOD (lod.json fromHeightM).
#   They were never served, but all ~830k islands were kept in every file.
write_lod() {
  local lod_level="$1" tolerance_m="$2" min_area_deg2="$3"
  local min_area_m2
  min_area_m2="$(awk -v area_deg2="$min_area_deg2" -v factor="$DEG2_TO_M2" 'BEGIN { printf "%.1f", area_deg2 * factor }')"
  printf 'LOD%s stage (simplify %sm, min envelope %s deg²)\n' "$lod_level" "$tolerance_m" "$min_area_deg2"

  ogr2ogr -f GPKG \
    -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
    "${work_dir}/lod${lod_level}_4087.gpkg" "${work_dir}/land_4087.gpkg" \
    -sql "SELECT * FROM land_polygons
          WHERE (ST_MaxX(geom) - ST_MinX(geom)) * (ST_MaxY(geom) - ST_MinY(geom)) >= ${min_area_m2}" \
    -simplify "$tolerance_m" -progress

  ogr2ogr -f GPKG \
    -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY \
    -t_srs EPSG:4326 -wrapdateline -makevalid -lco SPATIAL_INDEX=YES \
    "${dest_dir}/land_lod${lod_level}.gpkg" "${work_dir}/lod${lod_level}_4087.gpkg" \
    -progress

  rm -f -- "${work_dir}/lod${lod_level}_4087.gpkg"
}

#         lod  tol_m  min_deg2  (client min_area: lod0 world 0.5, lod1 0.5, lod2 0.4, lod3 0.005)
write_lod 0    8906   0.25
write_lod 1    3340   0.25
write_lod 2    1113   0.2
write_lod 3    557    0.0025
write_lod 4    225    0
write_lod 5    111    0

printf 'Removing unnecessary data\n'
rm -rf -- "${work_dir:?}" "${dest_dir:?}/${archive_name:?}"

# Plate reconstruction: plate-tagged copies of the fresh LODs (no-op without the
# Cao model files). The API server would also rebuild them on its next start.
# The tag and file names must match the plateModel section of lod.json.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
external_dir="$(cd -- "${script_dir}/../external" && pwd)"
static_source="${external_dir}/cao_rot/static_polygons.gpmlz"
if [ -f "$static_source" ]; then
  printf 'Plate-tagging LODs (cao_prep.sh)\n'
  "${external_dir}/cao_prep.sh" "$dest_dir" "$static_source" cao \
    land_lod0.gpkg land_lod1.gpkg land_lod2.gpkg land_lod3.gpkg land_lod4.gpkg land_lod5.gpkg
fi
