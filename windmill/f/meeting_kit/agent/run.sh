# run — run one meeting-kit agent on Windmill's `agent` worker.
#
# A template: `meeting-kit render` fills its placeholders from the repository's meeting-kit.yaml and writes it to
# f/<folder>/agent/run. Edit the kit's template, not the rendered copy.
#
# f/meeting_kit/agent/run is the one agent runner the flows share: a flow step calls it with an agent name. It is the
# Windmill adapter for `meeting-kit run`, and nothing more: it gives the runner what it needs (the mounted checkout of
# the repository and its tools, the remote and a key that can clone and push it, the MCP config, the Claude token, the
# owner's time zone), then reports the runner's summary as this job's result. What an agent does, its tools, its write
# scope, the checks, the commit (and its author) and the push are all the runner's, read from the repository at run
# time.
#
# Windmill reads the arguments from the three assignments below. `input` is the runner's --input: a JSON object (the
# calendar gate's day for meeting-triage, one meeting for meeting-briefing), or empty.
agent="$1"
input="${2:-}"
dry_run="${3:-false}"

set -euo pipefail

# Which agents exist is the runner's to say (it fails on one it doesn't know), so it isn't repeated here, where it
# would drift. The name only has to be safe in a path and a label.
case "$agent" in ''|*[!a-z-]*)
  echo "agent must be a runner agent name, not '$agent'" >&2; exit 2 ;; esac
case "$dry_run" in true|false) ;; *)
  echo "dry_run must be true or false, not '$dry_run'" >&2; exit 2 ;; esac

# The agents write to "today" in the owner's time (the runner's --today default), and the schedules fire in it too.
export TZ="{{timezone}}"

# --- the runner and its tools: the host's checkout, mounted read-only ------------------------------------------------
#
# The host keeps a pull-only checkout of the repository's main branch, builds the repository's tools package into its
# .local/tools after each pull, and mounts the checkout read-only (and /nix/store, which the tools link into). The
# tools are `meeting-kit` (the runner, with its own bun) and the vault's index, check-kb and check-tasks, which the
# runner runs from MEETING_KIT_TOOLS since the worker has no Nix.
# Both are checked first, before any secret is read. MEETING_KIT_CODE exists for the kit's tests; nothing sets it on
# Windmill.
mount="{{mount}}"
code="${MEETING_KIT_CODE:-$mount}"
tools="$code/.local/tools/bin"
unset MEETING_KIT_CODE
[ -f "$code/meeting-kit.yaml" ] || {
  echo "$code/meeting-kit.yaml is missing: the host mounts the repository's checkout at $code" >&2; exit 1; }
for app in meeting-kit index check-kb check-tasks; do
  [ -x "$tools/$app" ] || {
    echo "$tools/$app is missing: the host builds the repository's tools package (meeting-kit, index, check-kb, check-tasks) into $code/.local/tools after each pull" >&2
    exit 1; }
done

# --- secrets: Windmill variables under f/meeting_kit/, read for this job only ---------------------------------------
#
# Never echoed, never in an argument list: they go into files in this job's directory or into the environment the
# runner and claude expect. All of them are read here, first, so that nothing after this section needs the job token.
var() {
  curl -sS --fail-with-body --max-time 30 -H "Authorization: Bearer $WM_TOKEN" \
    "$BASE_INTERNAL_URL/api/w/$WM_WORKSPACE/variables/get_value/f/meeting_kit/$1" | jq -er .
}

job_dir="$PWD"
umask 077
trap 'rm -f "$job_dir/deploy_key"' EXIT
var repo_deploy_key >"$job_dir/deploy_key"
var known_hosts >"$job_dir/known_hosts"
repo_url="$(var repo_url)"
# The MCP servers' key, in the environment variable the MCP config names. Read by plain assignment, so a failed read
# stops the job (set -e); printf is a builtin, so the value is in no argument list.
api_key_env="{{api_key_env}}"
api_key="$(var "{{api_key_variable}}")"
printf -v "$api_key_env" '%s' "$api_key"
unset api_key
CLAUDE_CODE_OAUTH_TOKEN="$(var claude_oauth_token)"

# --- drop Windmill's identity before running anything else --------------------------------------------------------
#
# WM_TOKEN carries the full permissions of the job's identity (often a workspace admin's). Nothing below needs it,
# and everything below (the Claude installer, git, the runner and every process claude starts) would otherwise
# inherit it. Windmill reads this job's result from ./result.json.
for name in "${!WM_@}" BASE_INTERNAL_URL BASE_URL; do unset "$name"; done
unset -f var

# --- tools: claude on the persistent home, the runner and the vault checks from the checkout --------------------------
#
# /agent-home is a volume on the agent worker, so the claude install outlives the job. This repository's account gets
# its own config dir there, apart from anything else the worker runs. MEETING_KIT_RUN_HOME exists for the kit's
# tests; nothing sets it on Windmill.
export HOME="${MEETING_KIT_RUN_HOME:-/agent-home}"
export CLAUDE_CONFIG_DIR="$HOME/{{claude_config_dir}}"
unset MEETING_KIT_RUN_HOME
mkdir -p "$CLAUDE_CONFIG_DIR"
export PATH="$tools:$HOME/.local/bin:$PATH"
# The runner's index and checks come from here instead of `nix run`.
export MEETING_KIT_TOOLS="$tools"

printf '%s\n' '{"autoUpdatesChannel": "stable", "cleanupPeriodDays": 30}' >"$CLAUDE_CONFIG_DIR/settings.json"
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash -s stable
fi
claude update >&2 || echo "claude update failed; running the installed version" >&2
claude_version="$(claude --version | awk '{print $1}')"
echo "claude $claude_version" >&2

# --- the vault: the runner's own clone, with this key -----------------------------------------------------------------
#
# The runner reads the agents' code and instructions from the checkout it runs from, and clones the vault itself
# (MEETING_KIT_REMOTE). The same key clones and pushes: the runner's git goes through GIT_SSH_COMMAND, so the key
# stays until the job ends (the trap above removes it). The model never sees it: claude runs --restricted, its file
# tools confined to the runner's clone in a temp dir, with no shell. The checkout belongs to another user, so git is
# told it is safe to read for the commit, which the result names.
export GIT_SSH_COMMAND="ssh -i $job_dir/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$job_dir/known_hosts -o StrictHostKeyChecking=yes"
commit="$(git -c safe.directory="$code" -C "$code" rev-parse --short HEAD)"
echo "checkout $commit" >&2

# --- the MCP config: the servers the agents may be given, the key by reference ----------------------------------------
#
# claude expands the ${...} header values from its environment; the file holds no secret. The runner narrows it to
# the agent's own servers.
cat >"$job_dir/mcp.json" <<'EOF'
{{mcp_servers_json}}
EOF

# --- run ------------------------------------------------------------------------------------------------------------
#
# A stray ANTHROPIC_API_KEY would win over the OAuth token in -p mode and bill the API instead of the subscription.
unset ANTHROPIC_API_KEY
export "${api_key_env?}" CLAUDE_CODE_OAUTH_TOKEN
export MEETING_KIT_REMOTE="$repo_url"
args=(run "$agent" --mcp-config "$job_dir/mcp.json")
[ "$dry_run" = true ] && args+=(--dry-run)
[ -n "$input" ] && args+=(--input "$input")

# A wedged run is stopped rather than holding the agent worker, which runs one job at a time. Windmill stops it
# first (this script's 90-minute timeout, or the flow step's own); these lines are the backstop.
case "$agent" in
  meeting-synthesis) limit=95m ;;   # the tick's step stops it at 90
  *)                 limit=35m ;;   # workday_start's steps stop triage at 15 and each briefing at 25
esac
rc=0
timeout --kill-after=30s "$limit" "$tools/meeting-kit" "${args[@]}" >"$job_dir/runner.out" || rc=$?
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "meeting-kit: $agent hit its $limit limit and was stopped" >&2
  exit "$rc"
fi

# The runner's last stdout line is its JSON summary; anything before it (a dry run's prompt) goes to the job log.
sed '$d' "$job_dir/runner.out" >&2
summary="$(tail -n 1 "$job_dir/runner.out")"
if ! jq -e 'type == "object" and has("status")' <<<"$summary" >/dev/null 2>&1; then
  echo "meeting-kit: the runner printed no summary (exit $rc)" >&2
  exit $(( rc == 0 ? 1 : rc ))
fi
if [ "$rc" -ne 0 ]; then
  # The job log's last lines are what a failed-job alert quotes: say which agent and why.
  echo "meeting-kit: $agent failed: $(jq -r '.error // "unknown error"' <<<"$summary")" >&2
  exit "$rc"
fi

# --- result ---------------------------------------------------------------------------------------------------------
#
# The runner's summary (status, created, cost, output, notices) is what the flows read: results.triage.output for the
# briefing loop, notices for the alert. wm_labels become labels on the job row, so the Runs page filters on them.
jq --arg commit "$commit" --arg claude "$claude_version" \
  '. + {commit: $commit, claude: $claude, wm_labels: ["agent:\(.agent)", "status:\(.status)"]}' <<<"$summary" >result.json
