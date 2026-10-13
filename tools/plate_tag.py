#!/usr/bin/env python3
"""
Cut land polygons by plate static polygons and tag each piece with its plate.

  plate_tag.py <land.gpkg> <static_polygons.gpkg> <out.gpkg> [--jobs N]

Input land layer `land_polygons` (EPSG:4326). Output layer `land_polygons` with:

  plate_id      reconstruction plate id of the static polygon the piece lies in
  from_age      Ma when that static polygon (and thus this piece) appears
  to_age        Ma when it disappears (0 = still exists)
  src_env_area  envelope area (deg²) of the ORIGINAL land polygon, so the API's
                min_area filter keeps all pieces of a continent together

Only static polygons that exist today (to_age == 0) are used. Land not covered by
any static polygon (gaps between them) goes to the nearest one. Overlapping static
polygons never duplicate land: each piece is subtracted once assigned.

The work is split into FID ranges processed in parallel (tools/plate_tagging/).
Requires GDAL Python bindings (`from osgeo import ogr`), e.g. system python3.
"""

from __future__ import annotations

import argparse
import math
import multiprocessing
import os
import shutil
import sys
import tempfile
import time

from osgeo import ogr
from plate_tagging.chunk_worker import ChunkTask, tag_chunk
from plate_tagging.geometry_filters import LAYER_NAME
from plate_tagging.output_layer import merge_parts

CHUNKS_PER_JOB = 8


def parse_arguments(argument_list: list[str] | None = None) -> argparse.Namespace:
    """Parse the command line.

    Usage:
        ``parse_arguments()`` reads sys.argv.

    Args:
        argument_list: Arguments without the program name, or None for sys.argv.

    Returns:
        Namespace with land, static, output and jobs.
    """
    arg_parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    arg_parser.add_argument("land")
    arg_parser.add_argument("static")
    arg_parser.add_argument("output", metavar="out")
    arg_parser.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    return arg_parser.parse_args(argument_list)


def read_feature_ids(land_path: str) -> list[int]:
    """List the FIDs of the land layer in iteration order.

    Usage:
        Basis for splitting the work into chunks.

    Args:
        land_path: Land GeoPackage.

    Returns:
        FIDs of every feature in ``land_polygons``.
    """
    land_source = ogr.Open(land_path)
    feature_ids = [land_feature.GetFID() for land_feature in land_source.GetLayer(LAYER_NAME)]
    land_source = None
    return feature_ids


def chunk_bounds(feature_ids: list[int], job_count: int) -> list[tuple[int, int]]:
    """Split FIDs into contiguous half-open ranges.

    Usage:
        About CHUNKS_PER_JOB chunks per worker keeps the pool balanced.

    Args:
        feature_ids: Non-empty FIDs in iteration order.
        job_count: Number of worker processes.

    Returns:
        List of (lower_fid, upper_fid) with lower inclusive and upper exclusive.
    """
    chunk_count = max(job_count * CHUNKS_PER_JOB, 1)
    step_size = max(1, math.ceil(len(feature_ids) / chunk_count))
    return [
        (feature_ids[start_idx], feature_ids[min(start_idx + step_size, len(feature_ids)) - 1] + 1)
        for start_idx in range(0, len(feature_ids), step_size)
    ]


def run_chunks(task_list: list[ChunkTask], job_count: int) -> None:
    """Process all chunks in a worker pool, printing progress on one line.

    Usage:
        Called by main between chunking and merging.

    Args:
        task_list: Chunks to process.
        job_count: Number of worker processes.

    Returns:
        None.
    """
    start_time = time.time()
    chunks_done = features_read = pieces_written = 0
    with multiprocessing.Pool(job_count) as worker_pool:
        for chunk_read, chunk_written in worker_pool.imap_unordered(tag_chunk, task_list):
            chunks_done += 1
            features_read += chunk_read
            pieces_written += chunk_written
            print(
                f"\r  {chunks_done}/{len(task_list)} chunks · {features_read} land → {pieces_written} plate pieces"
                f" · {time.time() - start_time:.0f}s",
                end="",
                flush=True,
            )
    print()


def cli_main(argument_list: list[str] | None = None) -> None:
    """Command-line entry point.

    Usage:
        ``plate_tag.py land.gpkg static.gpkg out.gpkg --jobs 8``.

    Args:
        argument_list: Arguments without the program name, or None for sys.argv.

    Returns:
        None; exits with a message when the land layer is empty.
    """
    arguments = parse_arguments(argument_list)
    feature_ids = read_feature_ids(arguments.land)
    if not feature_ids:
        sys.exit(f"{arguments.land}: no features in {LAYER_NAME}")
    output_dir = os.path.dirname(os.path.abspath(arguments.output))
    scratch_dir = tempfile.mkdtemp(prefix="plate_tag_", dir=output_dir)
    try:
        task_list = [
            ChunkTask(
                arguments.land,
                arguments.static,
                lower_fid,
                upper_fid,
                os.path.join(scratch_dir, f"part{chunk_idx:04d}.gpkg"),
            )
            for chunk_idx, (lower_fid, upper_fid) in enumerate(chunk_bounds(feature_ids, arguments.jobs))
        ]
        run_chunks(task_list, arguments.jobs)
        merge_parts([chunk_task.output_path for chunk_task in task_list], arguments.output)
    finally:
        shutil.rmtree(scratch_dir, ignore_errors=True)


if __name__ == "__main__":
    cli_main()
