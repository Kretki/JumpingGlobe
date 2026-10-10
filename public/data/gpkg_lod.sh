#!/usr/bin/env bash
set -euo pipefail

zip_path="${1:?usage: $0 <zip> <dir>}"
dest_dir="${2:?usage: $0 <zip> <dir>}"

[ -f "$zip_path" ] || { printf 'not a zip file: %s\n' "$zip_path" >&2; exit 1; }

zip_base="$(basename -- "$zip_path")"
name="${zip_base%.*}"
dest_dir="${dest_dir%/}"
work="${dest_dir}/.lod_work"

mkdir -p -- "$dest_dir" "$work"
cp -- "$zip_path" "${dest_dir}/${zip_base}"

printf 'Unzip stage\n'
unzip -o -- "${dest_dir}/${zip_base}" -d "$dest_dir" > /dev/null
rm -f -- "${dest_dir}/${zip_base}"

shp="${dest_dir}/${name}/land_polygons.shp"
[ -f "$shp" ] || { printf 'missing shapefile: %s\n' "$shp" >&2; exit 1; }

printf 'Convert to gpkg stage\n'
ogr2ogr -f GPKG -t_srs EPSG:4326 \
  -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -lco SPATIAL_INDEX=YES \
  "${work}/land.gpkg" "$shp" \
  -progress

printf 'Metre master stage (EPSG:4087)\n'
ogr2ogr -f GPKG -t_srs EPSG:4087 \
  -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -lco SPATIAL_INDEX=YES \
  "${work}/land_4087.gpkg" "${work}/land.gpkg" \
  -progress

write_lod() {
  local lod="$1" tol_m="$2"
  printf 'LOD%s stage (simplify %sm, segmentize %sm)\n' "$lod" "$tol_m" "$tol_m"

  ogr2ogr -f GPKG \
    -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
    "${work}/lod${lod}_4087.gpkg" "${work}/land_4087.gpkg" \
    -simplify "$tol_m" -progress

  ogr2ogr -f GPKG \
    -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY \
    "${work}/lod${lod}_seg.gpkg" "${work}/lod${lod}_4087.gpkg" \
    -segmentize "$tol_m" -progress

  ogr2ogr -f GPKG \
    -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY \
    -t_srs EPSG:4326 -wrapdateline -makevalid -lco SPATIAL_INDEX=YES \
    "${dest_dir}/land_lod${lod}.gpkg" "${work}/lod${lod}_seg.gpkg" \
    -progress

  rm -f -- "${work}/lod${lod}_4087.gpkg" "${work}/lod${lod}_seg.gpkg"
}

write_lod 0 8906
write_lod 1 3340
write_lod 2 1113
write_lod 3 557
write_lod 4 225
write_lod 5 111

printf 'Removing unnecessary data\n'
rm -rf -- "$work" "${dest_dir}/${name}"
