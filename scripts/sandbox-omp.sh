#!/usr/bin/env bash
# Prepare or start an omp session that cannot touch the real ~/.omp tree.
# Plugin source is always the current git worktree.
set -euo pipefail

REAL_HOME="${REAL_HOME:-$HOME}"
SANDBOX_ROOT="${OMP_ANIM_SANDBOX:-/tmp/omp-anim-sandbox}"
SANDBOX_HOME="$SANDBOX_ROOT/home"
SANDBOX_PROJECT="$SANDBOX_ROOT/project"
SESSION_NAME="${OMP_ANIM_SANDBOX_SESSION:-omp-anim-sandbox}"
PLUGIN_NAME="@oh-my-pi/animations"

die() {
	printf 'sandbox-omp: %s\n' "$*" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

repo_root() {
	git rev-parse --show-toplevel 2>/dev/null || die "run this from the omp-animations git worktree"
}

real_omp() {
	printf '%s/.omp' "$REAL_HOME"
}

assert_isolated() {
	local real
	real="$(real_omp)"
	case "$SANDBOX_HOME" in
	"$REAL_HOME" | "$real" | "$real"/*)
		die "SANDBOX_HOME must not be inside the real home or $real"
		;;
	esac
	if [[ "$SANDBOX_HOME" == "$REAL_HOME" ]]; then
		die "SANDBOX_HOME equals REAL_HOME"
	fi
}

copy_tree() {
	local src="$1"
	local dest="$2"
	if [[ ! -e "$src" ]]; then
		return 0
	fi
	mkdir -p "$(dirname "$dest")"
	rsync -a --delete "$src" "$dest"
}

backup_agent_db() {
	local src="$1"
	local dest="$2"
	mkdir -p "$(dirname "$dest")"
	if [[ ! -f "$src" ]]; then
		return 0
	fi
	sqlite3 "$src" ".backup '$dest'"
}

plugin_link() {
	printf '%s/.omp/plugins/node_modules/%s' "$SANDBOX_HOME" "$PLUGIN_NAME"
}

prepare() {
	need git
	need rsync
	need sqlite3
	need omp
	assert_isolated

	local repo
	repo="$(repo_root)"
	[[ -f "$repo/package.json" ]] || die "not an omp-animations checkout: $repo"

	mkdir -p "$SANDBOX_HOME/.omp/agent" "$SANDBOX_HOME/.agents" "$SANDBOX_PROJECT"

	if [[ ! -f "$SANDBOX_PROJECT/README.md" ]]; then
		printf '# sandbox project\n\nThrowaway cwd for omp-anim-sandbox. Not a real repo.\n' >"$SANDBOX_PROJECT/README.md"
	fi

	local real_agent
	real_agent="$(real_omp)/agent"

	copy_tree "$real_agent/AGENTS.md" "$SANDBOX_HOME/.omp/agent/AGENTS.md"
	copy_tree "$real_agent/config.yml" "$SANDBOX_HOME/.omp/agent/config.yml"
	copy_tree "$real_agent/models.yml" "$SANDBOX_HOME/.omp/agent/models.yml"
	copy_tree "$real_agent/agents/" "$SANDBOX_HOME/.omp/agent/agents/"
	copy_tree "$real_agent/skills/" "$SANDBOX_HOME/.omp/agent/skills/"
	copy_tree "$real_agent/managed-skills/" "$SANDBOX_HOME/.omp/agent/managed-skills/"
	backup_agent_db "$real_agent/agent.db" "$SANDBOX_HOME/.omp/agent/agent.db"

	copy_tree "$REAL_HOME/.agents/rules/" "$SANDBOX_HOME/.agents/rules/"
	copy_tree "$REAL_HOME/.agents/skills/" "$SANDBOX_HOME/.agents/skills/"
	copy_tree "$REAL_HOME/.agents/commands/" "$SANDBOX_HOME/.agents/commands/"

	# Install under the fake HOME so the lockfile cannot touch ~/.omp/plugins.
	HOME="$SANDBOX_HOME" omp plugin install "$repo"

	local link
	link="$(plugin_link)"
	local resolved
	resolved="$(readlink "$link" 2>/dev/null || true)"
	[[ -n "$resolved" ]] || die "plugin link missing after install: $link"
	if [[ "$resolved" != "$repo" ]]; then
		die "plugin link is $resolved, expected $repo"
	fi

	printf 'sandbox-omp: prepared\n'
	printf '  repo     %s\n' "$repo"
	printf '  home     %s\n' "$SANDBOX_HOME"
	printf '  project  %s\n' "$SANDBOX_PROJECT"
	printf '  plugin   %s -> %s\n' "$link" "$resolved"
}

start() {
	need tmux
	need omp
	assert_isolated
	[[ -d "$SANDBOX_HOME/.omp" ]] || die "run: $0 prepare"

	if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
		printf 'sandbox-omp: session %s already exists\n' "$SESSION_NAME"
		printf '  attach: tmux attach -t %s\n' "$SESSION_NAME"
		return 0
	fi

	# HOME isolation only. Do not wrap this TUI in sandbox-exec.
	tmux new-session -d -s "$SESSION_NAME" \
		-c "$SANDBOX_PROJECT" -x 200 -y 50 \
		"env HOME=$SANDBOX_HOME OMP_ANIMATIONS=full OMP_ANIMATIONS_CADENCE_EQUALIZER=true OMP_ANIMATIONS_REFLECTION_RIPPLE=true omp --cwd $SANDBOX_PROJECT --no-session"

	printf 'sandbox-omp: started tmux session %s\n' "$SESSION_NAME"
	printf '  attach: tmux attach -t %s\n' "$SESSION_NAME"
}

status() {
	printf 'sandbox-omp: root %s\n' "$SANDBOX_ROOT"
	if [[ -d "$SANDBOX_HOME/.omp" ]]; then
		printf '  home     ready\n'
	else
		printf '  home     missing (run prepare)\n'
	fi
	local link
	link="$(plugin_link)"
	if [[ -L "$link" ]]; then
		printf '  plugin   %s\n' "$(readlink "$link")"
	else
		printf '  plugin   not installed\n'
	fi
	if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
		printf '  session  %s (live)\n' "$SESSION_NAME"
	else
		printf '  session  %s (absent)\n' "$SESSION_NAME"
	fi
}

reset() {
	assert_isolated
	if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
		tmux kill-session -t "$SESSION_NAME"
	fi
	rm -rf "$SANDBOX_ROOT"
	printf 'sandbox-omp: removed %s\n' "$SANDBOX_ROOT"
}

usage() {
	cat <<EOF
Usage: $0 [prepare|start|status|reset]

  prepare  Copy skills, agents, rules, and auth into a fake HOME.
           Install this git worktree as @oh-my-pi/animations.
  start    Open tmux session $SESSION_NAME with that HOME.
  status   Print sandbox paths and the plugin link.
  reset    Kill the session and delete $SANDBOX_ROOT.

Override paths with OMP_ANIM_SANDBOX and REAL_HOME.
Never points at $REAL_HOME/.omp.
EOF
}

cmd="${1:-prepare}"
case "$cmd" in
prepare) prepare ;;
start) start ;;
status) status ;;
reset) reset ;;
-h | --help | help) usage ;;
*)
	usage >&2
	exit 2
	;;
esac
