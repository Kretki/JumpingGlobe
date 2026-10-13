#!/usr/bin/env bash
# Build the plate-reconstruction layers (Merdith et al. 2021) for the globe.
#
# Usage:
#   merdith_prep.sh <lods_dir> <merdith_dir> <lod.gpkg> [<lod.gpkg> ...]
#
# Arguments:
#   lods_dir     directory with the land LOD GeoPackages (lod.json dataDir)
#   merdith_dir  directory with shapes_static_polygons_Merdith_et_al.gpml
#   lod.gpkg     LOD file names inside lods_dir to plate-tag, in processing order
#
# Writes NEW files into lods_dir (existing LODs are never modified):
#   merdith_static.gpkg       simplified Merdith static polygons (plate id, name,
#                             lifetime) — the client uses them to find which plate
#                             a clicked point belongs to
#   <lod>_plates.gpkg         each listed LOD cut along static-polygon boundaries,
#                             pieces tagged plate_id / from_age / to_age / src_env_area
#
# LODs are processed in the order given and each output is published as soon as it
# is done, so the world LOD (listed first) is usable within seconds while the large
# detail LODs (several minutes each) are still being tagged.
#
# The API server runs this automatically in the background when outputs are missing
# or older than their sources; gpkg_lod.sh also runs it after a rebuild.
#
# Needs: ogr2ogr, and a python3 with GDAL bindings and defusedxml
# (Debian/Ubuntu: python3-gdal python3-defusedxml).
# Override the interpreter with PYTHON=/path/to/python3.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/../.." && pwd)"
[ "$#" -ge 3 ] || { printf 'usage: %s <lods_dir> <merdith_dir> <lod.gpkg>...\n' "$0" >&2; exit 2; }
lods_dir="${1%/}"
merdith_dir="${2%/}"
shift 2
python_bin="${PYTHON:-/usr/bin/python3}"

static_gpml="${merdith_dir}/shapes_static_polygons_Merdith_et_al.gpml"
[ -f "$static_gpml" ] || { printf 'missing: %s\n' "$static_gpml" >&2; exit 1; }
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

work_dir="$(mktemp -d "${lods_dir}/.merdith_work.XXXXXX")"
trap 'rm -rf -- "${work_dir:?}"' EXIT

printf 'Static polygons: GPML -> GeoPackage\n'
"$python_bin" "${project_root}/tools/gpml_to_geojson.py" "$static_gpml" "${work_dir}/static.geojson"
ogr2ogr -f GPKG -nln static -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
  "${work_dir}/static.gpkg" "${work_dir}/static.geojson"

# Picking copy for the browser: ~2 km simplification keeps it small; plate lookup
# only needs plate-scale accuracy.
ogr2ogr -f GPKG -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
  -lco SPATIAL_INDEX=YES -lco GEOMETRY_NAME=geom -simplify 0.02 \
  -dialect SQLite \
  -sql "SELECT geometry, plate_id, from_age, to_age, name,
               (ST_MaxX(geometry) - ST_MinX(geometry)) * (ST_MaxY(geometry) - ST_MinY(geometry)) AS src_env_area
        FROM static" \
  "${work_dir}/merdith_static.gpkg" "${work_dir}/static.geojson"
mv -f -- "${work_dir}/merdith_static.gpkg" "${lods_dir}/merdith_static.gpkg"

for lod_file in "$@"; do
  output_gpkg="${lods_dir}/${lod_file%.gpkg}_plates.gpkg"
  printf 'Plate-tagging %s -> %s\n' "$lod_file" "$(basename -- "$output_gpkg")"
  "$python_bin" "${project_root}/tools/plate_tag.py" "${lods_dir}/${lod_file}" "${work_dir}/static.gpkg" \
    "${work_dir}/plates.gpkg"
  printf '\n'
  mv -f -- "${work_dir}/plates.gpkg" "$output_gpkg"
done
printf 'Done.\n'
