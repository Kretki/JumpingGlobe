#!/usr/bin/env bash
# Helper functions for public/fetch_sources.sh (sourced, not run).
#
# Usage:
#   source public/fetch_helpers.sh
#
# Functions:
#   log_stage <text>                              print a stage heading
#   require_tools <tool> [<tool> ...]             exit 1 when a command is missing
#   sha256_matches <file> <sha256>                0 when the file exists and matches
#   download_file <url> <dest> <sha256|-> [http]  download (HTTPS only unless "http" is given),
#                                                 verify the checksum ("-" = none published),
#                                                 skip when a matching copy exists
#   extract_members <zip> <dest_dir> <member>...  copy named zip members (paths inside the
#                                                 archive) flat into dest_dir, atomically per file
#   install_file <source> <dest>                  copy a file into place atomically (mode 644)
#
# Globals read: FORCE_DOWNLOAD ("1" re-downloads even when a verified copy exists).
# Every function prints errors to stderr and returns non-zero on failure.

# shellcheck shell=bash

log_stage() {
  printf '\n== %s\n' "$1"
}

require_tools() {
  local tool_name
  for tool_name in "$@"; do
    command -v "$tool_name" > /dev/null 2>&1 || { printf 'missing tool: %s\n' "$tool_name" >&2; exit 1; }
  done
}

sha256_matches() {
  local file_path="$1" expected_sha="$2"
  [ -f "$file_path" ] || return 1
  [ "$(sha256sum -- "$file_path" | awk '{print $1}')" = "$expected_sha" ]
}

download_file() {
  local source_url="$1" dest_path="$2" expected_sha="$3" protocol_choice="${4:-https}"
  local allowed_protocols='=https'
  [ "$protocol_choice" = "http" ] && allowed_protocols='=http,https'
  if [ "${FORCE_DOWNLOAD:-0}" != "1" ] && [ -f "$dest_path" ]; then
    if [ "$expected_sha" = "-" ] || sha256_matches "$dest_path" "$expected_sha"; then
      printf 'cached: %s\n' "$(basename -- "$dest_path")"
      return 0
    fi
  fi
  mkdir -p -- "$(dirname -- "$dest_path")"
  local partial_path="${dest_path}.part"
  printf 'downloading: %s\n' "$source_url"
  if ! curl --fail --location --proto "$allowed_protocols" --proto-redir "$allowed_protocols" \
    --retry 3 --retry-delay 5 --connect-timeout 30 --progress-bar \
    --output "$partial_path" -- "$source_url"; then
    rm -f -- "$partial_path"
    printf 'download failed: %s\n' "$source_url" >&2
    return 1
  fi
  if [ "$expected_sha" != "-" ] && ! sha256_matches "$partial_path" "$expected_sha"; then
    printf 'checksum mismatch for %s (expected %s)\n' "$source_url" "$expected_sha" >&2
    printf 'the source may have been updated; check it and update the pinned checksum\n' >&2
    rm -f -- "$partial_path"
    return 1
  fi
  mv -f -- "$partial_path" "$dest_path"
}

install_file() {
  local source_path="$1" dest_path="$2"
  local dest_dir partial_path
  dest_dir="$(dirname -- "$dest_path")"
  mkdir -p -- "$dest_dir"
  partial_path="$(mktemp "${dest_dir}/.install.XXXXXX")"
  cp -- "$source_path" "$partial_path"
  chmod 644 -- "$partial_path"
  mv -f -- "$partial_path" "$dest_path"
}

extract_members() {
  local zip_path="$1" dest_dir="$2"
  shift 2
  local unpack_dir member_path
  unpack_dir="$(mktemp -d)"
  # Only the named members are extracted, flat (-j), so archive paths cannot escape unpack_dir.
  if ! unzip -q -o -j "$zip_path" "$@" -d "$unpack_dir"; then
    rm -rf -- "${unpack_dir:?}"
    printf 'could not extract from %s\n' "$zip_path" >&2
    return 1
  fi
  for member_path in "$@"; do
    install_file "${unpack_dir}/$(basename -- "$member_path")" "${dest_dir}/$(basename -- "$member_path")"
    printf 'installed: %s\n' "$(basename -- "$member_path")"
  done
  rm -rf -- "${unpack_dir:?}"
}
