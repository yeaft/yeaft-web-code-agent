#!/bin/sh

set -eu

REMOTE_TAG_REF='refs/yeaft-release/authoritative-tag'

error() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

cleanup() {
  git update-ref -d "$REMOTE_TAG_REF" >/dev/null 2>&1 || true
}

validate_tag() {
  if ! printf '%s\n' "$1" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    error 'Tag must match v<major>.<minor>.<patch>.'
  fi
}

fetch_remote_tag() {
  tag=$1
  cleanup
  if ! git fetch --quiet --force --no-tags origin \
    "+refs/tags/${tag}:${REMOTE_TAG_REF}"
  then
    error "Remote tag '${tag}' does not exist on origin."
  fi
}

resolve_remote_tag() {
  tag=$1
  fetch_remote_tag "$tag"
  if ! tag_commit=$(git rev-parse --verify "${REMOTE_TAG_REF}^{commit}" 2>/dev/null); then
    error "Remote tag '${tag}' does not peel to a commit."
  fi
  printf '%s\n' "$tag_commit"
}

verify_release() {
  tag=$1
  release_commit=$2

  case "$release_commit" in
    ''|*[!0-9a-f]*) error 'RELEASE_COMMIT must be a full lowercase Git object ID.' ;;
  esac
  case ${#release_commit} in
    40|64) ;;
    *) error 'RELEASE_COMMIT must be a full lowercase Git object ID.' ;;
  esac

  cleanup
  if ! remote_refs=$(git ls-remote origin \
    'refs/heads/main' "refs/tags/${tag}" "refs/tags/${tag}^{}")
  then
    error 'Unable to read authoritative origin release refs.'
  fi
  main_object=$(printf '%s\n' "$remote_refs" | awk '$2 == "refs/heads/main" { print $1 }')
  tag_object=$(printf '%s\n' "$remote_refs" | awk -v ref="refs/tags/${tag}" '$2 == ref { print $1 }')
  tag_peeled=$(printf '%s\n' "$remote_refs" | awk -v ref="refs/tags/${tag}^{}" '$2 == ref { print $1 }')
  [ -n "$main_object" ] || error 'Remote branch origin/main does not exist.'
  [ -n "$tag_object" ] || error "Remote tag '${tag}' does not exist on origin."
  tag_commit=${tag_peeled:-$tag_object}

  if [ "$tag_commit" != "$release_commit" ]; then
    error "Remote tag '${tag}' peels to ${tag_commit}, expected RELEASE_COMMIT ${release_commit}."
  fi
  if [ "$main_object" != "$release_commit" ]; then
    error "origin/main points to ${main_object}, expected RELEASE_COMMIT ${release_commit}."
  fi

  if ! git fetch --quiet --force --no-tags origin \
    "+refs/heads/main:refs/remotes/origin/main" \
    "+refs/tags/${tag}:${REMOTE_TAG_REF}"
  then
    error "Unable to fetch authoritative origin/main and remote tag '${tag}'."
  fi

  if ! tag_commit=$(git rev-parse --verify "${REMOTE_TAG_REF}^{commit}" 2>/dev/null); then
    error "Remote tag '${tag}' does not peel to a commit."
  fi
  if ! main_commit=$(git rev-parse --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null); then
    error 'Fetched origin/main does not peel to a commit.'
  fi

  if [ "$main_commit" != "$main_object" ]; then
    error 'Authoritative origin/main changed while the release fence was fetching it.'
  fi
  if [ "$tag_commit" != "${tag_peeled:-$tag_object}" ]; then
    error "Remote tag '${tag}' changed while the release fence was fetching it."
  fi
  if [ "$tag_commit" != "$release_commit" ]; then
    error "Remote tag '${tag}' peels to ${tag_commit}, expected RELEASE_COMMIT ${release_commit}."
  fi
  if [ "$main_commit" != "$release_commit" ]; then
    error "origin/main points to ${main_commit}, expected RELEASE_COMMIT ${release_commit}."
  fi
  if ! checkout_commit=$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null); then
    error 'Current checkout HEAD does not peel to a commit.'
  fi
  if [ "$checkout_commit" != "$release_commit" ]; then
    error "Current checkout HEAD points to ${checkout_commit}, expected RELEASE_COMMIT ${release_commit}."
  fi

  printf "Release fence passed: remote tag '%s', origin/main, and checkout HEAD point to %s.\n" \
    "$tag" "$release_commit"
}

trap cleanup EXIT

command=${1:-}
case "$command" in
  resolve)
    [ "$#" -eq 2 ] || error 'Usage: verify-dev-release.sh resolve <tag>'
    validate_tag "$2"
    resolve_remote_tag "$2"
    ;;
  verify)
    [ "$#" -eq 3 ] || error 'Usage: verify-dev-release.sh verify <tag> <release-commit>'
    validate_tag "$2"
    verify_release "$2" "$3"
    ;;
  *)
    error 'Usage: verify-dev-release.sh {resolve <tag>|verify <tag> <release-commit>}'
    ;;
esac
