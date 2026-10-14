#!/usr/bin/env bash
# Build the plate-reconstruction layers (Cao et al. 2024, 1.8 Ga model) for the globe.
#
# Usage:
#   cao_prep.sh <lods_dir> <static_polygons.gpml[z]> <model_tag> <lod.gpkg> [<lod.gpkg> ...]
#
# Arguments:
#   lods_dir          directory with the land LOD GeoPackages (lod.json dataDir)
#   static_polygons   static-polygon file of the plate model
#                     (lod.json plateModel: sourceDir/staticPolygons,
#                     e.g. public/external/cao_rot/static_polygons.gpmlz)
#   model_tag         lod.json plateModel.tag ([a-z0-9_], e.g. "cao"); names the outputs
#   lod.gpkg          LOD file names inside lods_dir to plate-tag, in processing order
#
# Writes NEW files into lods_dir (existing LODs are never modified):
#   <tag>_static.gpkg          simplified static polygons (plate id, name, lifetime) —
#                              the client uses them to find which plate a clicked
#                              point belongs to
#   <tag>_plate_outlines.gpkg  static polygons dissolved per plate id and lifetime —
#                              the client rotates them to the displayed age and draws
#                              them as a wireframe with optional plate names
#   <lod>_<tag>_plates.gpkg    each listed LOD cut along static-polygon boundaries,
#                              pieces tagged plate_id / from_age / to_age / src_env_area
#
# LODs are processed in the order given and each output is published as soon as it
# is done, so the world LOD (listed first) is usable within seconds while the large
# detail LODs (several minutes each) are still being tagged.
#
# The API server runs this automatically in the background when outputs are missing
# or older than their sources; public/data/gpkg_lod.sh also runs it after a rebuild.
#
# Exit status: 0 on success, 1 on missing inputs/tools or a failed step, 2 on bad usage.
#
# Needs: ogr2ogr, and a python3 with GDAL bindings and defusedxml
# (Debian/Ubuntu: python3-gdal python3-defusedxml).
# Override the interpreter with PYTHON=/path/to/python3.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/../.." && pwd)"
[ "$#" -ge 4 ] || {
  printf 'usage: %s <lods_dir> <static_polygons.gpml[z]> <model_tag> <lod.gpkg>...\n' "$0" >&2
  exit 2
}
lods_dir="${1%/}"
static_source="$2"
model_tag="$3"
shift 3
python_bin="${PYTHON:-/usr/bin/python3}"

[[ "$model_tag" =~ ^[a-z0-9_]{1,32}$ ]] || { printf 'invalid model tag: %s\n' "$model_tag" >&2; exit 2; }
[ -f "$static_source" ] || { printf 'missing: %s\n' "$static_source" >&2; exit 1; }
for lod_file in "$@"; do
  case "$lod_file" in
    */* | .*) printf 'invalid LOD file name: %s\n' "$lod_file" >&2; exit 2 ;;
  esac
  [ -f "${lods_dir}/${lod_file}" ] || { printf 'missing: %s\n' "${lods_dir}/${lod_file}" >&2; exit 1; }
done
command -v ogr2ogr >/dev/null || { printf 'ogr2ogr not found (install gdal-bin)\n' >&2; exit 1; }
"$python_bin" -c 'from osgeo import ogr; import defusedxml' 2>/dev/null || {
  printf '%s lacks GDAL bindings or defusedxml (install python3-gdal python3-defusedxml or set PYTHON=...)\n' \
    "$python_bin" >&2
  exit 1
}

work_dir="$(mktemp -d "${lods_dir}/.${model_tag}_work.XXXXXX")"
trap 'rm -rf -- "${work_dir:?}"' EXIT

printf 'Static polygons: GPML -> GeoPackage\n'
"$python_bin" "${project_root}/tools/gpml_to_geojson.py" "$static_source" "${work_dir}/static.geojson"
ogr2ogr -f GPKG -nln static -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
  "${work_dir}/static.gpkg" "${work_dir}/static.geojson"

# Picking copy for the browser: ~2 km simplification keeps it small; plate lookup
# only needs plate-scale accuracy.
printf 'Picking polygons -> %s_static.gpkg\n' "$model_tag"
ogr2ogr -f GPKG -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
  -lco SPATIAL_INDEX=YES -lco GEOMETRY_NAME=geom -simplify 0.02 \
  -dialect SQLite \
  -sql "SELECT geometry, plate_id, from_age, to_age, name,
               (ST_MaxX(geometry) - ST_MinX(geometry)) * (ST_MaxY(geometry) - ST_MinY(geometry)) AS src_env_area
        FROM static" \
  "${work_dir}/picking.gpkg" "${work_dir}/static.geojson"
mv -f -- "${work_dir}/picking.gpkg" "${lods_dir}/${model_tag}_static.gpkg"

# Wireframe copy: fragments of one plate with the same lifetime are merged, so only
# boundaries between plates (or plate generations) remain. The tiny buffer closes
# hairline gaps between fragments that would otherwise leave internal lines;
# ~5 km simplification is plenty for an outline drawn over the whole globe.
# The outline is named after its largest fragment: with a single MAX() aggregate,
# SQLite takes the bare "name" column from the row where that maximum occurs.
printf 'Plate outlines -> %s_plate_outlines.gpkg\n' "$model_tag"
ogr2ogr -f GPKG -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
  -lco SPATIAL_INDEX=YES -lco GEOMETRY_NAME=geom -simplify 0.05 \
  -dialect SQLite \
  -sql "SELECT geometry, plate_id, from_age, to_age, name, src_env_area FROM (
          SELECT ST_Union(ST_Buffer(geom, 0.0005)) AS geometry, plate_id, from_age, to_age,
                 MAX(ST_Area(geom)) AS largest_area, name,
                 (ST_MaxX(ST_Union(geom)) - ST_MinX(ST_Union(geom)))
                   * (ST_MaxY(ST_Union(geom)) - ST_MinY(ST_Union(geom))) AS src_env_area
          FROM static GROUP BY plate_id, from_age, to_age)" \
  "${work_dir}/outlines.gpkg" "${work_dir}/static.gpkg"
mv -f -- "${work_dir}/outlines.gpkg" "${lods_dir}/${model_tag}_plate_outlines.gpkg"

for lod_file in "$@"; do
  output_gpkg="${lods_dir}/${lod_file%.gpkg}_${model_tag}_plates.gpkg"
  printf 'Plate-tagging %s -> %s\n' "$lod_file" "$(basename -- "$output_gpkg")"
  "$python_bin" "${project_root}/tools/plate_tag.py" "${lods_dir}/${lod_file}" "${work_dir}/static.gpkg" \
    "${work_dir}/plates.gpkg"
  printf '\n'
  mv -f -- "${work_dir}/plates.gpkg" "$output_gpkg"
done
printf 'Done.\n'
