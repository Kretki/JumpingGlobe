#!/usr/bin/env bash
# Export the topological plate polygons of the Cao et al. 2024 model to JSON for the globe.
#
# Usage:
#   cao_topologies.sh <output.json> <topology.gpml> [<topology.gpml> ...]
#
# Arguments:
#   output.json     file to write (lod.json dataDir/<tag>_topologies.json)
#   topology.gpml   GPML/GPMLZ files with TopologicalClosedPlateBoundary features and
#                   every feature their sections reference (lod.json plateModel.topologyFiles,
#                   e.g. public/external/cao_rot/250-0_plate_boundaries.gpml ...
#                   TopologyBuildingBlocks.gpml)
#
# Output: one JSON document {"version", "features", "topologies"} with the plate
# polygons (plate id, name, lifetime, section lists per time window) and the ridge,
# subduction-zone, transform, ... geometries they are built from, in present-day
# coordinates. It is written to a temporary file and moved into place, so readers
# never see a partial file.
#
# The API server runs this automatically when the output is missing or older than
# its sources.
#
# Exit status: 0 on success, 1 on missing inputs/tools or a failed export, 2 on bad usage.
#
# Needs: a python3 with defusedxml (Debian/Ubuntu: python3-defusedxml).
# Override the interpreter with PYTHON=/path/to/python3.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/../.." && pwd)"
[ "$#" -ge 2 ] || { printf 'usage: %s <output.json> <topology.gpml>...\n' "$0" >&2; exit 2; }
output_json="$1"
shift
python_bin="${PYTHON:-/usr/bin/python3}"

case "$output_json" in
  *.json) ;;
  *) printf 'output must be a .json file: %s\n' "$output_json" >&2; exit 2 ;;
esac
for topology_file in "$@"; do
  [ -f "$topology_file" ] || { printf 'missing: %s\n' "$topology_file" >&2; exit 1; }
done
"$python_bin" -c 'import defusedxml' 2>/dev/null || {
  printf '%s lacks defusedxml (install python3-defusedxml or set PYTHON=...)\n' "$python_bin" >&2
  exit 1
}

output_dir="$(dirname -- "$output_json")"
mkdir -p -- "$output_dir"
partial_json="$(mktemp "${output_dir}/.topologies.XXXXXX")"
trap 'rm -f -- "${partial_json:?}"' EXIT

printf 'Exporting plate topologies -> %s\n' "$(basename -- "$output_json")"
"$python_bin" "${project_root}/tools/gpml_topologies.py" "$partial_json" "$@"
chmod 644 -- "$partial_json"
mv -f -- "$partial_json" "$output_json"
printf 'Done.\n'
