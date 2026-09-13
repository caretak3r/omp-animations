#!/usr/bin/env bash
# Isolation tripwire for subagent dispatch: `snapshot` the primary checkout before
# handing work to worktree-leased agents, `verify` after. Any drift is a breach.
set -euo pipefail

usage() {
	echo "usage: $0 {snapshot|verify} <root> <manifest-path>" >&2
	exit 2
}

# One line per file on disk, sorted by path:
#   sha256 <hex>\t<path>   regular file
#   link <target>\t<path>  symlink (target recorded, never followed)
# .beads/ .frames/ node_modules/ churn legitimately during a session and are skipped.
build_manifest() {
	local root="$1" out="$2"
	git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
		echo "error: $root is not a git worktree" >&2
		exit 2
	}
	local hash_cmd
	if command -v sha256sum >/dev/null 2>&1; then
		hash_cmd=(sha256sum)
	else
		hash_cmd=(shasum -a 256)
	fi

	local -a regular=() links=()
	local rel abs
	while IFS= read -r -d '' rel; do
		case "$rel" in .beads/* | .frames/* | node_modules/*) continue ;; esac
		abs="$root/$rel"
		if [[ -L "$abs" ]]; then
			links+=("link $(readlink "$abs")"$'\t'"$rel")
		elif [[ -f "$abs" ]]; then
			regular+=("$abs")
		fi
	done < <(git -C "$root" ls-files --cached --others --exclude-standard -z)

	{
		if ((${#regular[@]})); then
			printf '%s\0' "${regular[@]}" | xargs -0 "${hash_cmd[@]}" | while read -r hash abs; do
				printf 'sha256 %s\t%s\n' "$hash" "${abs#"$root"/}"
			done
		fi
		if ((${#links[@]})); then printf '%s\n' "${links[@]}"; fi
	} | sort -t $'\t' -k2 >"$out"
}

verify() {
	local root="$1" manifest="$2"
	[[ -f "$manifest" ]] || {
		echo "error: manifest not found: $manifest" >&2
		exit 2
	}
	local current
	current=$(mktemp)
	# shellcheck disable=SC2064
	trap "rm -f '$current'" EXIT
	build_manifest "$root" "$current"

	local drift
	drift=$(awk -F'\t' '
		FILENAME == ARGV[1] { old[$2] = $1; next }
		{ new[$2] = $1 }
		END {
			for (p in old) {
				if (!(p in new)) print "removed " p
				else if (old[p] != new[p]) print "changed " p
			}
			for (p in new) if (!(p in old)) print "added " p
		}' "$manifest" "$current" | sort -k2)

	if [[ -z "$drift" ]]; then
		echo "tripwire: clean"
		return 0
	fi
	printf '%s\n' "$drift"
	echo "tripwire: $(printf '%s\n' "$drift" | wc -l | tr -d ' ') drifted path(s)"
	return 1
}

[[ $# -eq 3 ]] || usage
case "$1" in
	snapshot) build_manifest "$2" "$3" ;;
	verify) verify "$2" "$3" ;;
	*) usage ;;
esac
