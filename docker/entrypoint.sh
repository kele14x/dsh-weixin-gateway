#!/bin/sh
# Register the gateway bundle in the DSH profile on first boot, then hand off to
# the real command. DSH_HOME is expected to be a persistent volume.
set -eu

profile="${DSH_PROFILE_NAME:-web}"
home="${DSH_HOME:-/data/dsh}"
manifest="${home}/profiles/${profile}/package.json"

mkdir -p "${home}"

if [ ! -f "${manifest}" ] || ! grep -q '"dsh-weixin-gateway"' "${manifest}"; then
  echo "dsh-weixin: registering the gateway bundle in profile ${profile}"
  # link: keeps the image copy as the single source of truth. This may need
  # network access the first time, because pnpm initializes the profile.
  dsh plugin --profile "${profile}" add -w link:/app
fi

exec "$@"
