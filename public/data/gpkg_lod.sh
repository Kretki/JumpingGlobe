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

# EPSG:4087 is plate carrée on WGS84 (1 deg = 111319.490793 m), so an envelope
# area in deg² (what the API's min_area filters on) is m² / DEG2_M2.
DEG2_M2=12392029030.5

# write_lod <lod> <simplify tolerance m> <min envelope area deg²>
#
# - No -segmentize: the client re-densifies rings geodesically to each LOD's
#   edge budget; pre-segmentized vertices only bloated the files and made
#   earcut produce slivers (the main cause of the slow world load).
# - Coarse LODs drop polygons whose envelope is below half of the smallest
#   min_area the client ever requests for that LOD (lod.json fromHeightM).
#   They were never served, but all ~830k islands were kept in every file.
write_lod() {
  local lod="$1" tol_m="$2" min_deg2="$3"
  local min_m2
  min_m2="$(awk -v a="$min_deg2" -v k="$DEG2_M2" 'BEGIN { printf "%.1f", a * k }')"
  printf 'LOD%s stage (simplify %sm, min envelope %s deg²)\n' "$lod" "$tol_m" "$min_deg2"

  ogr2ogr -f GPKG \
    -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY -makevalid \
    "${work}/lod${lod}_4087.gpkg" "${work}/land_4087.gpkg" \
    -sql "SELECT * FROM land_polygons
          WHERE (ST_MaxX(geom) - ST_MinX(geom)) * (ST_MaxY(geom) - ST_MinY(geom)) >= ${min_m2}" \
    -simplify "$tol_m" -progress

  ogr2ogr -f GPKG \
    -nln land_polygons -nlt PROMOTE_TO_MULTI -dim XY \
    -t_srs EPSG:4326 -wrapdateline -makevalid -lco SPATIAL_INDEX=YES \
    "${dest_dir}/land_lod${lod}.gpkg" "${work}/lod${lod}_4087.gpkg" \
    -progress

  rm -f -- "${work}/lod${lod}_4087.gpkg"
}

#         lod  tol_m  min_deg2  (client min_area: lod0 world 0.5, lod1 0.5, lod2 0.4, lod3 0.005)
write_lod 0    8906   0.25
write_lod 1    3340   0.25
write_lod 2    1113   0.2
write_lod 3    557    0.0025
write_lod 4    225    0
write_lod 5    111    0

printf 'Removing unnecessary data\n'
rm -rf -- "$work" "${dest_dir}/${name}"
