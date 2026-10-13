#!/usr/bin/env bash
# Build the plate-reconstruction layers (Merdith et al. 2021) for the globe.
#
#   merdith_prep.sh <lods_dir> <merdith_dir> <lod.gpkg> [<lod.gpkg> ...]
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
# Needs: ogr2ogr, and a python3 with GDAL bindings (Debian/Ubuntu: python3-gdal).
# Override the interpreter with PYTHON=/path/to/python3.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "${here}/../.." && pwd)"
[ "$#" -ge 3 ] || { printf 'usage: %s <lods_dir> <merdith_dir> <lod.gpkg>...\n' "$0" >&2; exit 2; }
lods="${1%/}"
merdith="${2%/}"
shift 2
py="${PYTHON:-/usr/bin/python3}"

static_gpml="${merdith}/shapes_static_polygons_Merdith_et_al.gpml"
[ -f "$static_gpml" ] || { printf 'missing: %s\n' "$static_gpml" >&2; exit 1; }
for lod in "$@"; do
  [ -f "${lods}/${lod}" ] || { printf 'missing: %s\n' "${lods}/${lod}" >&2; exit 1; }
done
command -v ogr2ogr >/dev/null || { printf 'ogr2ogr not found (install gdal-bin)\n' >&2; exit 1; }
"$py" -c 'from osgeo import ogr' 2>/dev/null || {
  printf '%s has no GDAL bindings (install python3-gdal or set PYTHON=...)\n' "$py" >&2
  exit 1
}

work="$(mktemp -d "${lods}/.merdith_work.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

printf 'Static polygons: GPML -> GeoPackage\n'
"$py" "${root}/tools/gpml_to_geojson.py" "$static_gpml" "${work}/static.geojson"
ogr2ogr -f GPKG -nln static -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
  "${work}/static.gpkg" "${work}/static.geojson"

# Picking copy for the browser: ~2 km simplification keeps it small; plate lookup
# only needs plate-scale accuracy.
ogr2ogr -f GPKG -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
  -lco SPATIAL_INDEX=YES -lco GEOMETRY_NAME=geom -simplify 0.02 \
  -dialect SQLite \
  -sql "SELECT geometry, plate_id, from_age, to_age, name,
               (ST_MaxX(geometry) - ST_MinX(geometry)) * (ST_MaxY(geometry) - ST_MinY(geometry)) AS src_env_area
        FROM static" \
  "${work}/merdith_static.gpkg" "${work}/static.geojson"
mv -f -- "${work}/merdith_static.gpkg" "${lods}/merdith_static.gpkg"

for lod in "$@"; do
  out="${lods}/${lod%.gpkg}_plates.gpkg"
  printf 'Plate-tagging %s -> %s\n' "$lod" "$(basename -- "$out")"
  "$py" "${root}/tools/plate_tag.py" "${lods}/${lod}" "${work}/static.gpkg" "${work}/plates.gpkg"
  printf '\n'
  mv -f -- "${work}/plates.gpkg" "$out"
done
printf 'Done.\n'
