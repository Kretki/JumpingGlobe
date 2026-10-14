"""Shared helpers of the background layer builders: build states, file freshness and logged script runs."""

from __future__ import annotations

# subprocess only runs fixed, repository-owned scripts with an argument list (no shell).
import subprocess  # nosec B404
from pathlib import Path

BUILD_TIMEOUT_SECONDS = 6 * 3600
STATUS_READY = "ready"
STATUS_BUILDING = "building"
STATUS_FAILED = "failed"
STATUS_UNAVAILABLE = "unavailable"


def modified_time(file_path: Path) -> float:
    """Return a file's modification time, or -1 when it does not exist.

    Usage:
        Staleness checks (an output is fresh when not older than its sources).

    Args:
        file_path: File to inspect.

    Returns:
        ``st_mtime`` in seconds, or -1.0 for missing files.
    """
    return file_path.stat().st_mtime if file_path.is_file() else -1.0


def newest_time(source_paths: list[Path]) -> float:
    """Return the newest modification time of several files.

    Usage:
        Baseline an output must be newer than.

    Args:
        source_paths: Source files (missing ones count as -1).

    Returns:
        Largest ``st_mtime``, or -1.0 for an empty list.
    """
    return max((modified_time(source_path) for source_path in source_paths), default=-1.0)


def last_log_line(log_path: Path) -> str:
    """Return the last non-empty line of a log file.

    Usage:
        Short failure reason for the status endpoint.

    Args:
        log_path: Log file to read.

    Returns:
        The last line, or "" when the file is missing, unreadable or empty.
    """
    try:
        log_lines = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
    except OSError:
        return ""
    return log_lines[-1] if log_lines else ""


def run_logged_script(command_line: list[str], log_path: Path, working_directory: Path) -> tuple[bool, str]:
    """Run a build script with its output written to a log file.

    Usage:
        Background builds. Every argument must come from lod.json or the repository
        layout, never from a client request.

    Args:
        command_line: Program and arguments (no shell is involved).
        log_path: Log file, overwritten.
        working_directory: Working directory of the script.

    Returns:
        Tuple (succeeded, error detail); the detail is "" unless the script could not be started.
    """
    try:
        with open(log_path, "w", encoding="utf-8") as log_stream:
            # Argument list, no shell; arguments are repository paths and lod.json values.
            completed = subprocess.run(  # noqa: S603  # nosec B603
                command_line,
                stdout=log_stream,
                stderr=subprocess.STDOUT,
                cwd=working_directory,
                timeout=BUILD_TIMEOUT_SECONDS,
                check=False,
            )
    except (OSError, subprocess.SubprocessError) as exception:
        return False, str(exception)
    return completed.returncode == 0, ""
