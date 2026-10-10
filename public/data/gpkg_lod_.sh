#!/usr/bin/env bash
set -eu

zip_path="${1:?usage: $0 <zip> <dir>}"
dest_dir="${2:?usage: $0 <zip> <dir>}"

[ -f "$zip_path" ] || { printf 'not a zip ile: %s\n' "$zip_path" >&2; exit 1; }

zip_base="$(basename -- "$zip_path")"
name="${zip_base%.*}"
dest_dir="${dest_dir%/}"
out_dir="${dest_dir%/}/${name}"

mkdir -p -- "$dest_dir"
cp -- "$zip_path" "${dest_dir%/}/${zip_base}"

printf "Unzip stage\n"

unzip -o -- "${dest_dir%/}/${zip_base}" -d "$dest_dir" > /dev/null

rm "${dest_dir%/}/${zip_base}"

printf "Convert to gpkg stage\n"

ogr2ogr -f GPKG -t_srs EPSG:4326 \
  -nlt MULTIPOLYGON -lco SPATIAL_INDEX=YES \
  "${dest_dir%/}/land.gpkg" \
  "${dest_dir%/}/${zip_base%.*}/land_polygons.shp" \
  -progress

printf "LOD0 stage\n"

ogr2ogr -f GPKG \
  "${dest_dir%/}/land_lod0.gpkg" "${dest_dir%/}/land.gpkg" \
  -simplify 0.08 -progress --config CPL_LOG /dev/null

printf "LOD1 stage\n"

ogr2ogr -f GPKG \
  "${dest_dir%/}/land_lod1.gpkg" "${dest_dir%/}/land.gpkg" \
  -simplify 0.03 -progress --config CPL_LOG /dev/null

printf "LOD2 stage\n"

ogr2ogr -f GPKG \
  "${dest_dir%/}/land_lod2.gpkg" "${dest_dir%/}/land.gpkg" \
  -simplify 0.01 -progress --config CPL_LOG /dev/null

printf "LOD3 stage\n"

ogr2ogr -f GPKG \
  "${dest_dir%/}/land_lod3.gpkg" "${dest_dir%/}/land.gpkg" \
  -simplify 0.005 -progress --config CPL_LOG /dev/null

printf "LOD4 stage\n"

ogr2ogr -f GPKG \
  "${dest_dir%/}/land_lod4.gpkg" "${dest_dir%/}/land.gpkg" \
  -simplify 0.001 -progress --config CPL_LOG /dev/null

printf "LOD5 stage\n"

ogr2ogr -f GPKG \
  "${dest_dir%/}/land_lod5.gpkg" "${dest_dir%/}/land.gpkg" \
  -simplify 0.0001 -progress --config CPL_LOG /dev/null


printf "Removing unnecessary data\n"

rm -r "${dest_dir%/}/${zip_base%.*}"

rm "${dest_dir%/}/land.gpkg"