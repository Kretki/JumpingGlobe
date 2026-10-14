#!/usr/bin/env bash
# Download the data sources listed in public/external/ARTICLES.md and build the derived
# files the globe needs, by running the project's .sh scripts on them.
#
# Usage:
#   public/fetch_sources.sh [--only <step>] [--force] [--skip-land]
#
# Steps (in this order; all by default):
#   cao         Cao et al. 2024 plate model, Zenodo 10.5281/zenodo.13628813
#               -> public/external/cao_rot/ (rotation, static-polygon and topology files)
#   tpw         Vaes & van Hinsbergen 2025 TPW data, Zenodo 10.5281/zenodo.14944326
#               -> public/external/tpw/input_APWP.xlsx, rates_T14.csv
#   pint        PINT paleointensity database v8.2.0 (Bono et al. 2022, Chen et al. 2026),
#               pintdb.org -> public/external/paleomagnetic_poles/PINTv820.csv
#               (the published .xlsx is converted with tools/xlsx_to_csv.py)
#   land        OSM land polygons (osmdata.openstreetmap.de, ~930 MB, rebuilt daily)
#               -> public/data/gpkg_lod.sh builds lod.json dataDir/land_lod*.gpkg and,
#               through public/external/cao_prep.sh, the plate-tagged layers.
#               Skipped when every land_lod*.gpkg exists, unless --force.
#   topologies  public/external/cao_topologies.sh -> dataDir/cao_topologies.json
#               (skipped when it exists, unless --force)
#
# Options:
#   --only <step>  run one step only
#   --force        download again even when a verified copy exists, and rebuild the
#                  land LODs and topologies
#   --skip-land    leave out the (large, slow) land step
#
# Downloads are cached in public/data/downloads/. Files with a published or pinned
# checksum are verified (SHA-256) before use; the OSM archive changes daily and has
# none. Only HTTPS is used, except for pintdb.org, which serves plain HTTP only; its
# file is protected by a pinned checksum.
#
# Needs: curl, unzip, sha256sum, awk; a python with defusedxml for the tools/ helpers
# (uv's project environment, or set TOOLS_PYTHON=/path/to/python3); for the land step
# ogr2ogr (gdal-bin) and a python with GDAL bindings for cao_prep.sh (PYTHON, default
# /usr/bin/python3, is passed through to public/data/gpkg_lod.sh and cao_prep.sh).
# Exit status: 0 on success, 1 on a failed step, 2 on bad usage.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"
external_dir="${script_dir}/external"
cache_dir="${script_dir}/data/downloads"
# shellcheck source=public/fetch_helpers.sh
source "${script_dir}/fetch_helpers.sh"

CAO_URL='https://zenodo.org/records/13628813/files/1.8Ga_model_GSF.zip?download=1'
CAO_SHA256='4ae9158a29c597b46f687f8c3f0f5a4a55df5ab69bde18e24257a17d358d8592'
CAO_FOLDER='1.8Ga_model_GSF'
TPW_RECORD_URL='https://zenodo.org/api/records/14944326/files'
TPW_FILES=('input_APWP.xlsx' 'rates_T14.csv')
TPW_SHA256=('b058b61f89eb0329686f1ea727655c401c3df89e92eac4df484ab6970733cb8b'
  '89132055699d38c15b1e3328f8b2fab2d54ff4be87565d7956be5ca1db8cd76a')
PINT_URL='http://www.pintdb.org/data/PINTv820.xlsx'
PINT_SHA256='1a13a9e218f2d7fbd239912540770b0ccb63f02934d6566144ffe9fa3bb7df91'
PINT_SHEET='PINTv820'
LAND_URL='https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip'
ALL_STEPS=(cao tpw pint land topologies)

FORCE_DOWNLOAD=0
only_step=''
skip_land=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only) only_step="${2:-}"; shift 2 ;;
    --force) FORCE_DOWNLOAD=1; shift ;;
    --skip-land) skip_land=1; shift ;;
    *) printf 'usage: %s [--only cao|tpw|pint|land|topologies] [--force] [--skip-land]\n' "$0" >&2; exit 2 ;;
  esac
done
if [ -n "$only_step" ] && [[ ! " ${ALL_STEPS[*]} " =~ \ ${only_step}\  ]]; then
  printf 'unknown step: %s (one of: %s)\n' "$only_step" "${ALL_STEPS[*]}" >&2
  exit 2
fi
export FORCE_DOWNLOAD

# run_python <args...>: the tools' python (TOOLS_PYTHON, else uv, else python3), from the project root.
run_python() {
  if [ -n "${TOOLS_PYTHON:-}" ]; then
    (cd -- "$project_root" && "$TOOLS_PYTHON" "$@")
  elif command -v uv > /dev/null 2>&1; then
    (cd -- "$project_root" && uv run --quiet python "$@")
  else
    (cd -- "$project_root" && python3 "$@")
  fi
}

# lod_setting <query>: print lod.json values (see tools/lod_settings.py), one per line.
lod_setting() {
  run_python -m tools.lod_settings "$1"
}

fetch_cao() {
  log_stage 'Cao et al. 2024 plate model (Zenodo 13628813)'
  local zip_path="${cache_dir}/1.8Ga_model_GSF.zip" member_list=() file_name
  download_file "$CAO_URL" "$zip_path" "$CAO_SHA256"
  while IFS= read -r file_name; do
    member_list+=("${CAO_FOLDER}/${file_name}")
  done < <(lod_setting model-files)
  extract_members "$zip_path" "${external_dir}/cao_rot" "${member_list[@]}"
}

fetch_tpw() {
  log_stage 'Vaes & van Hinsbergen 2025 TPW data (Zenodo 14944326)'
  local file_index
  for file_index in "${!TPW_FILES[@]}"; do
    local file_name="${TPW_FILES[$file_index]}"
    download_file "${TPW_RECORD_URL}/${file_name}/content" "${cache_dir}/${file_name}" "${TPW_SHA256[$file_index]}"
    install_file "${cache_dir}/${file_name}" "${external_dir}/tpw/${file_name}"
    printf 'installed: %s\n' "$file_name"
  done
}

fetch_pint() {
  log_stage 'PINT paleointensity database v8.2.0 (pintdb.org)'
  local xlsx_path="${cache_dir}/PINTv820.xlsx"
  download_file "$PINT_URL" "$xlsx_path" "$PINT_SHA256" http
  run_python -m tools.xlsx_to_csv "$xlsx_path" "$PINT_SHEET" "${external_dir}/paleomagnetic_poles/PINTv820.csv"
}

fetch_land() {
  log_stage 'OSM land polygons and land LODs (gpkg_lod.sh)'
  local data_dir lod_count present_lods
  data_dir="${project_root}/$(lod_setting data-dir)"
  lod_count="$(lod_setting lod-count)"
  present_lods="$(find "$data_dir" -maxdepth 1 -name 'land_lod[0-9].gpkg' 2> /dev/null | wc -l)"
  if [ "$FORCE_DOWNLOAD" != "1" ] && [ "$present_lods" -ge "$lod_count" ]; then
    printf 'land LODs present in %s (use --force to rebuild)\n' "$data_dir"
    return 0
  fi
  require_tools ogr2ogr
  download_file "$LAND_URL" "${cache_dir}/land-polygons-split-4326.zip" -
  bash "${script_dir}/data/gpkg_lod.sh" "${cache_dir}/land-polygons-split-4326.zip" "$data_dir"
}

build_topologies() {
  log_stage 'Plate topologies (cao_topologies.sh)'
  local data_dir output_json topology_paths=() file_name
  data_dir="${project_root}/$(lod_setting data-dir)"
  output_json="${data_dir}/$(lod_setting model-tag)_topologies.json"
  if [ "$FORCE_DOWNLOAD" != "1" ] && [ -f "$output_json" ]; then
    printf '%s present (use --force to rebuild; the API server also rebuilds it when stale)\n' "$(basename -- "$output_json")"
    return 0
  fi
  while IFS= read -r file_name; do
    topology_paths+=("${external_dir}/cao_rot/${file_name}")
  done < <(lod_setting topology-files)
  # cao_topologies.sh needs defusedxml: unless PYTHON is set, use the tools' python.
  local topology_python="${PYTHON:-}"
  [ -n "$topology_python" ] || topology_python="$(run_python -c 'import sys; print(sys.executable)')"
  PYTHON="$topology_python" bash "${external_dir}/cao_topologies.sh" "$output_json" "${topology_paths[@]}"
}

require_tools curl unzip sha256sum awk
mkdir -p -- "$cache_dir"
for step_name in "${ALL_STEPS[@]}"; do
  [ -n "$only_step" ] && [ "$step_name" != "$only_step" ] && continue
  [ "$step_name" = "land" ] && [ "$skip_land" = "1" ] && continue
  case "$step_name" in
    cao) fetch_cao ;;
    tpw) fetch_tpw ;;
    pint) fetch_pint ;;
    land) fetch_land ;;
    topologies) build_topologies ;;
  esac
done
printf '\nAll requested steps finished.\n'
