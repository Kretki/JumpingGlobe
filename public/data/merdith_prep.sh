#!/usr/bin/env bash
# Build the plate-reconstruction layers (Merdith et al. 2021) for the globe.
#
#   merdith_prep.sh [lods_dir] [merdith_dir] [world_file]
#     lods_dir     land LOD GeoPackages (default: ./lods next to this script)
#     merdith_dir  Merdith files incl. meredith.rot (default: ./meredith_rot)
#     world_file   world LOD to plate-tag (default: land_lod0.gpkg)
#
# Writes two NEW files into lods_dir (existing LODs are never modified):
#   land_lod0_plates.gpkg     world LOD cut along Merdith static-polygon boundaries,
#                             each piece tagged plate_id / from_age / to_age /
#                             src_env_area — the land that moves on the timeline
#   merdith_continents.gpkg   continental crust (incl. shelves and vanished
#                             terranes), drawn under the land
#
# The API server runs this automatically in the background when those files are
# missing or older than their sources; gpkg_lod.sh also runs it after a rebuild.
# Detail LODs (1-5) are only shown at present day, so they need no plate tags.
#
# Needs: ogr2ogr, and a python3 with GDAL bindings (Debian/Ubuntu: python3-gdal).
# Override the interpreter with PYTHON=/path/to/python3.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "${here}/../.." && pwd)"
lods="${1:-${here}/lods}"
merdith="${2:-${here}/meredith_rot}"
world="${3:-land_lod0.gpkg}"
lods="${lods%/}"
merdith="${merdith%/}"
py="${PYTHON:-/usr/bin/python3}"

static_gpml="${merdith}/shapes_static_polygons_Merdith_et_al.gpml"
continents_gpml="${merdith}/shapes_continents.gpml"
world_in="${lods}/${world}"
world_out="${lods}/${world%.gpkg}_plates.gpkg"

for f in "$static_gpml" "$continents_gpml" "$world_in"; do
  [ -f "$f" ] || { printf 'missing: %s\n' "$f" >&2; exit 1; }
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

printf 'Continental crust layer: GPML -> merdith_continents.gpkg\n'
"$py" "${root}/tools/gpml_to_geojson.py" "$continents_gpml" "${work}/continents.geojson"
ogr2ogr -f GPKG -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
  -lco SPATIAL_INDEX=YES -lco GEOMETRY_NAME=geom \
  -dialect SQLite \
  -sql "SELECT geometry, plate_id, from_age, to_age, name,
               (ST_MaxX(geometry) - ST_MinX(geometry)) * (ST_MaxY(geometry) - ST_MinY(geometry)) AS src_env_area
        FROM continents" \
  "${work}/merdith_continents.gpkg" "${work}/continents.geojson"

printf 'Plate-tagging %s -> %s\n' "$world" "$(basename -- "$world_out")"
"$py" "${root}/tools/plate_tag.py" "$world_in" "${work}/static.gpkg" "${work}/plates.gpkg"

# Publish both only once everything succeeded.
mv -f -- "${work}/merdith_continents.gpkg" "${lods}/merdith_continents.gpkg"
mv -f -- "${work}/plates.gpkg" "$world_out"
printf 'Done.\n'
