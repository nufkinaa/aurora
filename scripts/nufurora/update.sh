#!/usr/bin/env bash
# Keep a server (nufurora.com) on the newest Aurora release, safely.
#
# Run by a systemd timer (deploy/linux/aurora-update.timer) or cron, every ten
# minutes. Each run:
#   1. fetches from GitHub and picks the target: the newest `server-*-stable`
#      tag (MODE=stable, the default) or the newest commit of origin/master
#      (MODE=master);
#   2. does nothing when the folder is already there; refuses (and changes
#      nothing) when the folder has local commits, files changed by hand, is
#      not on the master branch, or when no way to restart Aurora is found;
#   3. waits while anyone is watching (asks the running server);
#   4. moves the branch forward (git merge --ff-only), runs `npm ci` only when
#      package-lock.json changed, restarts Aurora the way it is supervised
#      (keeper, systemd or pm2), and waits for the new version to answer
#      GET /healthz;
#   5. if it does not, moves back, restarts the old version, remembers the
#      release as bad (it is skipped until a newer one appears) and says so.
#
# Settings: scripts/nufurora/update.conf.example lists every key and its
# default. The file read is $AURORA_UPDATE_CONF, else /etc/aurora-update.conf,
# else <repo>/data/auto-update.conf. A key set in the environment wins over
# the file (handy for `DRY_RUN=1 scripts/nufurora/update.sh`).
# The install steps: docs/nufurora-auto-update.md.
#
# Exit codes
#   0  nothing to do; put off (someone watching, the server just started,
#      another run busy, a release that failed before skipped); a dry run;
#      or updated and healthy
#   1  refused or failed safely: nothing was changed, or the change was put
#      back before any restart (diverged, files changed by hand, wrong branch,
#      no way to restart, the watching count unreadable, fetch / merge / npm
#      failed)
#   2  the new version failed its health check and was rolled back; the old
#      version is healthy again
#   3  needs a person: the rollback did not bring a healthy server back, or
#      could not be done
#   4  set-up problem: bad settings, not a git checkout, git or node missing
#
# The whole script is functions, and the only command is on the last line:
# bash reads a script while it runs it, and this file is itself replaced by
# the update it performs.
set -u

CONF_KEYS="AURORA_DIR MODE REMOTE BRANCH PORT HEALTH_TIMEOUT RESTART_CMD NPM_CI_CMD COUNT_PAUSED WATCH_CHECK MIN_SERVER_UPTIME LOG_FILE STATE_FILE ALERT_CMD DRY_RUN NODE_BIN SYSTEMD_UNIT PM2_NAME SYSTEMCTL_BIN SUDO_BIN PM2_BIN"

# (main sets TZ=UTC: the times are UTC, and printed without starting a process)
ts() { printf '%(%Y-%m-%dT%H:%M:%SZ)T' -1; }
now() { if [ -n "${EPOCHSECONDS:-}" ]; then printf '%s' "$EPOCHSECONDS"; else date +%s; fi; }

log() {
  local line
  printf -v line '%(%Y-%m-%dT%H:%M:%SZ)T %s' -1 "$*"
  printf '%s\n' "$line"
  if [ -n "${LOG_FILE:-}" ]; then printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null; fi
  return 0
}

# Command output on one line, with any user:password@ taken out of URLs.
oneline() {
  sed -E 's#(://)[^/@[:space:]]+@#\1***@#g' | tr '\r\n' '  ' | sed -E 's/  +/ /g; s/^ //; s/ $//' | cut -c1-400
}

short() { printf '%s' "${1:0:9}"; }

isnum() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

g() { git -C "$AURORA_DIR" "$@"; }

# Every outside command that may leave something running (a restart, npm, the
# alert) goes through here: fd 9 (the flock) is closed for it, so that a
# daemon it starts cannot keep the lock after this run ends.
with_timeout() {
  local secs=$1
  shift
  if [ "$HAVE_TIMEOUT" = 1 ]; then timeout "$secs" "$@" 9>&-; else "$@" 9>&-; fi
}

# ---- the state file: key=value lines ----
# (plain bash loops: no extra process per call)
state_get() {
  local line v=""
  [ -f "$STATE_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$1="*) v=${line#*=} ;; esac
  done < "$STATE_FILE"
  printf '%s' "$v"
}
state_set() {
  [ "$DRY_RUN" = 1 ] && return 0
  local tmp="$STATE_FILE.tmp.$$" val=${2//[$'\r\n']/ } line
  {
    if [ -f "$STATE_FILE" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in "$1="*) ;; *) printf '%s\n' "$line" ;; esac
      done < "$STATE_FILE"
    fi
    if [ -n "$val" ]; then printf '%s=%s\n' "$1" "$val"; fi
  } > "$tmp" && mv -f "$tmp" "$STATE_FILE"
  return 0
}

# Log a message at most once a day while it stays the same.
note() {
  local key=$1 cur
  shift
  printf -v cur '%(%Y-%m-%d)T %s' -1 "$*"
  if [ "$(state_get "note_$key")" != "$cur" ]; then
    log "$*"
    state_set "note_$key" "$cur"
  fi
}
# Log a message once while it stays the same.
note_once() {
  local key=$1
  shift
  if [ "$(state_get "note_$key")" != "$*" ]; then
    log "$*"
    state_set "note_$key" "$*"
  fi
}

alert() {
  [ -n "$ALERT_CMD" ] || return 0
  [ "$DRY_RUN" = 1 ] && return 0
  (cd "$AURORA_DIR" && with_timeout 60 bash -c "$ALERT_CMD" aurora-update "$1") >/dev/null 2>&1 || log "ALERT_CMD failed (exit $?)"
  return 0
}

count_failure() {
  local n
  n=$(state_get fail_count)
  isnum "$n" || n=0
  n=$((n + 1))
  state_set fail_count "$n"
  if [ "$n" -eq 3 ]; then alert "Aurora auto-update has not been able to update 3 runs in a row: $1"; fi
  return 0
}
clear_failures() {
  local n
  n=$(state_get fail_count)
  if [ -n "$n" ] && [ "$n" != 0 ]; then state_set fail_count 0; fi
  return 0
}

# Refused or failed safely: say why (once a day), count it.
refuse() {
  local key=$1
  shift
  note "$key" "$*"
  count_failure "$*"
}

probe() {
  local extra=()
  if [ -n "$PORT" ]; then extra=(--port "$PORT"); fi
  "$NODE_BIN" "$PROBE_JS" "$@" --dir "$AURORA_DIR" ${extra[@]+"${extra[@]}"}
}

pkg_version() { g show "$1:package.json" 2>/dev/null | "$NODE_BIN" "$PROBE_JS" version-of 2>/dev/null; }

# ---- the lock: one run at a time ----
acquire_lock() {
  local lock="$STATE_FILE.lock" d pid i
  if command -v flock >/dev/null 2>&1 && [ "${AURORA_UPDATE_NO_FLOCK:-0}" != 1 ]; then
    exec 9>>"$lock" || return 1
    flock -n 9 || return 1
    return 0
  fi
  d="$lock.d"
  for i in 1 2; do
    if mkdir "$d" 2>/dev/null; then
      printf '%s\n' "$$" > "$d/pid"
      LOCK_DIR=$d
      return 0
    fi
    pid=$(cat "$d/pid" 2>/dev/null)
    if [ -z "$pid" ]; then
      sleep 1 # the other run may be between its mkdir and writing its pid
      pid=$(cat "$d/pid" 2>/dev/null)
    fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 1; fi
    log "removing a stale lock (pid ${pid:-unknown}, try $i)"
    rm -rf "$d"
  done
  return 1
}

cleanup() {
  if [ -n "${LOCK_DIR:-}" ]; then rm -rf "$LOCK_DIR"; fi
  if [ -n "${TMP_DIR:-}" ]; then rm -rf "$TMP_DIR"; fi
}

# ---- how Aurora is restarted here ----
is_root() { [ "$(id -u 2>/dev/null)" = 0 ]; }
systemd_active() {
  command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 && "$SYSTEMCTL_BIN" is-active --quiet "$SYSTEMD_UNIT" >/dev/null 2>&1
}
systemd_can_restart() {
  is_root && return 0
  command -v "$SUDO_BIN" >/dev/null 2>&1 || return 1
  "$SUDO_BIN" -n -l "$SYSTEMCTL_BIN" restart "$SYSTEMD_UNIT" >/dev/null 2>&1
}
pm2_has() {
  # only a pm2 that is already running: any pm2 command starts its daemon
  [ -e "${PM2_HOME:-${HOME:-/nonexistent}/.pm2}/rpc.sock" ] || return 1
  command -v "$PM2_BIN" >/dev/null 2>&1 || return 1
  "$PM2_BIN" jlist 2>/dev/null | grep -q "\"name\":\"$PM2_NAME\""
}

# Sets RESTART_METHOD (keeper|systemd|pm2|custom) and RESTART_WHY. 1 = none.
decide_restart() {
  local old=$1 new=$2 kpid keeper_changed=0
  RESTART_METHOD=""
  RESTART_WHY=""
  if [ "$RESTART_CMD" != auto ]; then
    RESTART_METHOD=custom
    RESTART_WHY="RESTART_CMD from the settings"
    return 0
  fi
  g diff --quiet "$old" "$new" -- scripts/keeper.js src/lib/keeper.js || keeper_changed=1
  if kpid=$(probe keeper 2>/dev/null) && isnum "$kpid"; then
    if [ "$keeper_changed" = 1 ] && systemd_active; then
      if systemd_can_restart; then
        RESTART_METHOD=systemd
        RESTART_WHY="systemctl restart $SYSTEMD_UNIT: the keeper (pid $kpid) runs under systemd and its own code changes in this update"
        return 0
      fi
      RESTART_METHOD=keeper
      RESTART_WHY="the keeper (pid $kpid). Its own code changes in this update, but this user may not run 'systemctl restart $SYSTEMD_UNIT', so the keeper keeps its old code until the next 'systemctl restart $SYSTEMD_UNIT'"
      return 0
    fi
    RESTART_METHOD=keeper
    RESTART_WHY="the keeper (pid $kpid)"
    if [ "$keeper_changed" = 1 ]; then RESTART_WHY="$RESTART_WHY; its own code changes in this update and is loaded the next time the keeper itself is started"; fi
    return 0
  fi
  if systemd_active; then
    if systemd_can_restart; then
      RESTART_METHOD=systemd
      RESTART_WHY="systemctl restart $SYSTEMD_UNIT"
      return 0
    fi
    RESTART_WHY="the systemd unit '$SYSTEMD_UNIT' is active but this user may not restart it (see the sudoers line in docs/nufurora-auto-update.md)"
    return 1
  fi
  if pm2_has; then
    RESTART_METHOD=pm2
    RESTART_WHY="pm2 restart $PM2_NAME"
    return 0
  fi
  RESTART_WHY="no keeper running (data/keeper-state.json), no active systemd unit '$SYSTEMD_UNIT', no pm2 process '$PM2_NAME'"
  return 1
}

do_restart() {
  local out rc
  case "$RESTART_METHOD" in
    keeper) out=$(cd "$AURORA_DIR" && with_timeout 90 "$NODE_BIN" scripts/keeper.js --restart 2>&1) ;;
    systemd)
      if is_root; then out=$(with_timeout 180 "$SYSTEMCTL_BIN" restart "$SYSTEMD_UNIT" 2>&1)
      else out=$(with_timeout 180 "$SUDO_BIN" -n "$SYSTEMCTL_BIN" restart "$SYSTEMD_UNIT" 2>&1); fi ;;
    pm2) out=$(with_timeout 120 "$PM2_BIN" restart "$PM2_NAME" 2>&1 | tail -n 3) ;;
    custom) out=$(cd "$AURORA_DIR" && with_timeout 180 bash -c "$RESTART_CMD" 2>&1) ;;
    *) out="no restart method"; false ;;
  esac
  rc=$?
  log "restart via $RESTART_METHOD: exit $rc${out:+: $(printf '%s' "$out" | oneline)}"
  return 0
}

run_npm() {
  local t0 rc outf
  t0=$(now)
  outf="$TMP_DIR/npm.out"
  log "package-lock.json changed: $NPM_CI_CMD"
  (cd "$AURORA_DIR" && with_timeout 1200 bash -c "$NPM_CI_CMD") > "$outf" 2>&1
  rc=$?
  if [ "$rc" = 0 ]; then
    log "npm done in $(( $(now) - t0 )) s"
    return 0
  fi
  log "npm failed (exit $rc): $(tail -n 8 "$outf" | oneline)"
  return 1
}

# Wait for /healthz to say ok, with version $1 (when known), from a process
# younger than the restart issued at $2 (epoch s).
wait_healthy() {
  local want=$1 since=$2 t r rc v u
  LAST_HEALTH=""
  while :; do
    t=$(now)
    r=$(probe health 2>/dev/null)
    rc=$?
    LAST_HEALTH=${r:-no answer}
    if [ "$rc" = 0 ]; then
      read -r _ v u <<< "$r"
      if isnum "$u" && { [ -z "$want" ] || [ "$v" = "$want" ]; } && [ "$u" -le $((t - since + 5)) ]; then
        HEALTHY_AFTER=$((t - since))
        return 0
      fi
    fi
    if [ $((t - since)) -ge "$HEALTH_TIMEOUT" ]; then return 1; fi
    sleep 2
  done
}

# 0 = go ahead, 1 = refused, 2 = put off until the next run
check_watchers() {
  local h rc n up what="watching"
  h=$(probe health 2>/dev/null)
  rc=$?
  if [ "$rc" != 0 ]; then
    log "the server does not answer /healthz (${h:-no answer}): nobody can be watching; going ahead"
    return 0
  fi
  read -r _ _ up <<< "$h"
  if isnum "$up" && [ "$up" -lt "$MIN_SERVER_UPTIME" ]; then
    log "the server started $up s ago: waiting until the people watching have reconnected (MIN_SERVER_UPTIME=$MIN_SERVER_UPTIME); trying again next run"
    return 2
  fi
  if [ "$WATCH_CHECK" = skip ]; then
    log "WATCH_CHECK=skip: not asking who is watching"
    return 0
  fi
  if [ "$COUNT_PAUSED" = yes ]; then
    n=$(probe watching --count-paused 2>&1)
    what="watching or paused"
  else
    n=$(probe watching 2>&1)
  fi
  rc=$?
  if [ "$rc" != 0 ] || ! isnum "$n"; then
    refuse watchcheck "not updating: could not read how many are watching ($(printf '%s' "$n" | oneline)); WATCH_CHECK=required. Give the server's admin password to this user (.env or config.json in the Aurora folder, or AURORA_ADMIN_PASSWORD), or set WATCH_CHECK=skip"
    return 1
  fi
  if [ "$n" -gt 0 ]; then
    log "$n $what; trying again next run"
    return 2
  fi
  log "nobody is watching"
  return 0
}

# Move from $1 to $2 ($3 names it), restart, check, roll back if needed.
# $4 = 1 when an interrupted run is being finished (the folder is already at $2).
apply_update() {
  local old=$1 new=$2 label=$3 resume=$4 old_ver new_ver need_npm=0 t0 out rc
  old_ver=$(pkg_version "$old")
  new_ver=$(pkg_version "$new")
  g diff --quiet "$old" "$new" -- package-lock.json || need_npm=1

  if ! decide_restart "$old" "$new"; then
    refuse nomethod "not updating to $label: no way to restart Aurora was found ($RESTART_WHY)"
    return 1
  fi

  check_watchers
  rc=$?
  if [ "$rc" = 1 ]; then return 1; fi
  if [ "$rc" = 2 ]; then return 0; fi

  local npm_word=no
  if [ "$need_npm" = 1 ]; then npm_word=yes; fi
  if [ "$DRY_RUN" = 1 ]; then
    log "DRY RUN: would update to $label: $(short "$old") (${old_ver:-?}) -> $(short "$new") (${new_ver:-?}); npm ci: $npm_word; restart via $RESTART_METHOD ($RESTART_WHY)"
    return 0
  fi

  state_set pending "$old $new"
  if [ "$resume" = 0 ]; then
    log "updating to $label: $(short "$old") (${old_ver:-?}) -> $(short "$new") (${new_ver:-?}); npm ci: $npm_word; restart via $RESTART_METHOD ($RESTART_WHY)"
    if ! out=$(g merge --ff-only "$new" 2>&1); then
      log "git merge --ff-only failed: $(printf '%s' "$out" | oneline)"
      state_set pending ""
      if [ "$(g rev-parse HEAD)" != "$old" ]; then
        g reset -q --keep "$old" >/dev/null 2>&1 || { log "could not move back to $(short "$old"): a person must look"; alert "Aurora auto-update: git merge failed and the folder could not be moved back to $(short "$old")"; return 3; }
      fi
      count_failure "git merge failed"
      return 1
    fi
  else
    log "finishing an interrupted update to $label: $(short "$old") (${old_ver:-?}) -> $(short "$new") (${new_ver:-?}); restart via $RESTART_METHOD ($RESTART_WHY)"
  fi

  if [ "$need_npm" = 1 ] && ! run_npm; then
    log "putting the code back to $(short "$old"); the server was not restarted"
    if ! g reset -q --keep "$old" >/dev/null 2>&1; then
      state_set pending ""
      log "could not move back to $(short "$old"): a person must look"
      alert "Aurora auto-update: npm failed for $label and the folder could not be moved back"
      return 3
    fi
    state_set pending ""
    if ! run_npm; then
      log "npm failed for the old version too: node_modules may be incomplete; the running server is fine until its next restart. A person must look"
      alert "Aurora auto-update: npm failed for $label and again for the old version; node_modules may be incomplete"
      return 3
    fi
    count_failure "npm failed for $label"
    return 1
  fi

  t0=$(now)
  do_restart
  if wait_healthy "$new_ver" "$t0"; then
    log "UPDATED to $label: $(short "$old") (${old_ver:-?}) -> $(short "$new") (${new_ver:-?}), healthy after ${HEALTHY_AFTER} s"
    state_set pending ""
    state_set last_update "$(ts) $label $new"
    clear_failures
    return 0
  fi

  log "the new version did not become healthy within $HEALTH_TIMEOUT s (last answer: $LAST_HEALTH); rolling back to $(short "$old")"
  if ! out=$(g reset --keep "$old" 2>&1); then
    state_set pending ""
    log "ROLLBACK FAILED: git reset --keep $(short "$old"): $(printf '%s' "$out" | oneline). A person must look"
    alert "Aurora auto-update: $label failed its health check and the rollback failed; a person must look"
    return 3
  fi
  if [ "$need_npm" = 1 ]; then run_npm || log "npm failed for the old version; restarting anyway"; fi
  state_set bad_target "$new"
  state_set bad_label "$label (${new_ver:-?}), failed $(ts)"
  state_set pending ""
  t0=$(now)
  do_restart
  if wait_healthy "$old_ver" "$t0"; then
    log "ROLLED BACK to $(short "$old") (${old_ver:-?}), healthy after ${HEALTHY_AFTER} s; $label is skipped until a newer one appears"
    alert "Aurora auto-update: $label (${new_ver:-?}) failed its health check and was rolled back to ${old_ver:-$(short "$old")}"
    return 2
  fi
  log "ROLLED BACK to $(short "$old") but the old version is not healthy either (last answer: $LAST_HEALTH). A person must look"
  alert "Aurora auto-update: $label failed its health check; rolled back, but the old version is not healthy either. A person must look"
  return 3
}

main() {
  local script_dir default_dir conf k size out rc head target label tag pending p_old p_new cur dirty
  export TZ=UTC
  script_dir=$(cd "$(dirname "$0")" && pwd -P) || return 4
  default_dir=$(cd "$script_dir/../.." && pwd -P) || return 4

  # settings: what the environment sets wins over the file
  for k in $CONF_KEYS; do
    if [ -n "${!k+x}" ]; then
      eval "__env_$k=\${$k}"
      eval "__has_$k=1"
    fi
  done
  if [ -n "${AURORA_UPDATE_CONF:-}" ]; then
    conf=$AURORA_UPDATE_CONF
    if [ ! -f "$conf" ]; then echo "$(ts) the settings file $conf (AURORA_UPDATE_CONF) does not exist" >&2; return 4; fi
  elif [ -f /etc/aurora-update.conf ]; then
    conf=/etc/aurora-update.conf
  else
    conf="${AURORA_DIR:-$default_dir}/data/auto-update.conf"
  fi
  if [ -f "$conf" ]; then
    # shellcheck source=/dev/null
    . "$conf" || { echo "$(ts) could not read the settings file $conf" >&2; return 4; }
  fi
  for k in $CONF_KEYS; do
    if eval "[ -n \"\${__has_$k:-}\" ]"; then eval "$k=\$__env_$k"; fi
  done

  AURORA_DIR=${AURORA_DIR:-$default_dir}
  MODE=${MODE:-stable}
  REMOTE=${REMOTE:-origin}
  BRANCH=${BRANCH:-master}
  PORT=${PORT:-}
  HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}
  RESTART_CMD=${RESTART_CMD:-auto}
  NPM_CI_CMD=${NPM_CI_CMD:-npm ci --omit=dev --no-audit --no-fund}
  COUNT_PAUSED=${COUNT_PAUSED:-yes}
  WATCH_CHECK=${WATCH_CHECK:-required}
  MIN_SERVER_UPTIME=${MIN_SERVER_UPTIME:-120}
  LOG_FILE=${LOG_FILE:-$AURORA_DIR/data/auto-update.log}
  STATE_FILE=${STATE_FILE:-$AURORA_DIR/data/auto-update.state}
  ALERT_CMD=${ALERT_CMD:-}
  DRY_RUN=${DRY_RUN:-0}
  NODE_BIN=${NODE_BIN:-node}
  SYSTEMD_UNIT=${SYSTEMD_UNIT:-aurora}
  PM2_NAME=${PM2_NAME:-aurora}
  SYSTEMCTL_BIN=${SYSTEMCTL_BIN:-systemctl}
  SUDO_BIN=${SUDO_BIN:-sudo}
  PM2_BIN=${PM2_BIN:-pm2}
  case "$DRY_RUN" in 1|yes|true) DRY_RUN=1 ;; *) DRY_RUN=0 ;; esac

  mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")" 2>/dev/null
  if [ -f "$LOG_FILE" ]; then
    size=$(wc -c < "$LOG_FILE" 2>/dev/null)
    if isnum "${size// /}" && [ "${size// /}" -gt 5242880 ]; then mv -f "$LOG_FILE" "$LOG_FILE.1"; fi
  fi

  local bad=""
  case "$MODE" in stable|master) ;; *) bad="MODE must be stable or master (is '$MODE')" ;; esac
  case "$WATCH_CHECK" in required|skip) ;; *) bad="WATCH_CHECK must be required or skip (is '$WATCH_CHECK')" ;; esac
  case "$COUNT_PAUSED" in yes|no) ;; *) bad="COUNT_PAUSED must be yes or no (is '$COUNT_PAUSED')" ;; esac
  isnum "$HEALTH_TIMEOUT" || bad="HEALTH_TIMEOUT must be a number of seconds (is '$HEALTH_TIMEOUT')"
  isnum "$MIN_SERVER_UPTIME" || bad="MIN_SERVER_UPTIME must be a number of seconds (is '$MIN_SERVER_UPTIME')"
  if [ -n "$PORT" ] && ! isnum "$PORT"; then bad="PORT must be a number (is '$PORT')"; fi
  if [ -n "$bad" ]; then log "settings: $bad"; return 4; fi
  command -v git >/dev/null 2>&1 || { log "git is not installed (or not on PATH)"; return 4; }
  command -v "$NODE_BIN" >/dev/null 2>&1 || { log "node was not found ('$NODE_BIN'); set NODE_BIN, or PATH in the service"; return 4; }
  g rev-parse --git-dir >/dev/null 2>&1 || { log "$AURORA_DIR is not a git checkout (or it belongs to another user: run this as the folder's owner)"; return 4; }

  # coreutils timeout (not Windows' own timeout.exe, should this run in Git Bash)
  HAVE_TIMEOUT=0
  if hash timeout 2>/dev/null; then
    case "${BASH_CMDS[timeout]:-}" in *[Ww]indows*|*[Ss]ystem32*|'') ;; *) HAVE_TIMEOUT=1 ;; esac
  fi
  export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never

  # a temp folder of our own (removed at the end); the helper is copied there,
  # because the update replaces the one in the Aurora folder
  LOCK_DIR=""
  TMP_DIR=""
  trap cleanup EXIT
  trap 'exit 1' INT TERM HUP
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aurora-update.XXXXXX" 2>/dev/null) || TMP_DIR=""
  if [ -z "$TMP_DIR" ] || [ ! -d "$TMP_DIR" ]; then
    TMP_DIR=""
    log "could not make a temp folder (TMPDIR=${TMPDIR:-/tmp})"
    return 4
  fi
  if cp "$script_dir/probe.js" "$TMP_DIR/probe.js" 2>/dev/null; then
    PROBE_JS="$TMP_DIR/probe.js"
  else
    PROBE_JS="$script_dir/probe.js"
  fi

  if ! acquire_lock; then
    log "another update run is busy; leaving it to that one"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then log "dry run: nothing will be changed (MODE=$MODE)"; fi

  # an earlier run that was stopped half-way (power cut, killed)?
  pending=$(state_get pending)
  if [ -n "$pending" ]; then
    p_old=${pending%% *}
    p_new=${pending#* }
    head=$(g rev-parse HEAD)
    if [ "$head" = "$p_new" ] && [ "$p_old" != "$p_new" ]; then
      apply_update "$p_old" "$p_new" "$(short "$p_new")" 1
      return $?
    fi
    log "an earlier run was stopped half-way ($(short "$p_old") -> $(short "$p_new")); the folder is at $(short "$head") now, so it is left as it is"
    state_set pending ""
  fi

  out=$(with_timeout 180 git -C "$AURORA_DIR" fetch --tags --force --prune "$REMOTE" 2>&1)
  rc=$?
  if [ "$rc" != 0 ]; then
    refuse fetch "git fetch $REMOTE failed (exit $rc): $(printf '%s' "$out" | oneline)"
    return 1
  fi

  if [ "$MODE" = stable ]; then
    tag=$(g tag -l 'server-*-stable' --sort=-v:refname | head -n 1)
    if [ -z "$tag" ]; then
      note notag "no server-*-stable tag yet; nothing to do (MODE=stable)"
      return 0
    fi
    target=$(g rev-parse -q --verify "refs/tags/$tag^{commit}") || { log "the tag $tag names no commit"; return 1; }
    label=$tag
  else
    target=$(g rev-parse -q --verify "refs/remotes/$REMOTE/$BRANCH^{commit}") || { log "there is no $REMOTE/$BRANCH after the fetch"; return 1; }
    label="$REMOTE/$BRANCH"
  fi
  head=$(g rev-parse HEAD) || { log "the folder has no commit checked out"; return 4; }

  if [ "$head" = "$target" ] || g merge-base --is-ancestor "$target" "$head" 2>/dev/null; then
    note uptodate "up to date: $(short "$head") ($label is $(short "$target"))"
    clear_failures
    return 0
  fi
  if ! g merge-base --is-ancestor "$head" "$target" 2>/dev/null; then
    refuse diverged "not updating to $label: the folder ($(short "$head")) has commits that $label does not have (diverged); fix it by hand"
    return 1
  fi
  if [ "$target" = "$(state_get bad_target)" ]; then
    note_once badskip "skipping $label ($(short "$target")): it failed its health check and was rolled back ($(state_get bad_label)); waiting for a newer one"
    return 0
  fi
  cur=$(g symbolic-ref -q --short HEAD)
  if [ "$cur" != "$BRANCH" ]; then
    refuse branch "not updating to $label: the folder is on '${cur:-a detached HEAD}', not on the branch $BRANCH"
    return 1
  fi
  dirty=$(g status --porcelain --untracked-files=no)
  if [ -n "$dirty" ]; then
    refuse dirty "not updating to $label: files changed by hand in the folder: $(printf '%s\n' "$dirty" | head -n 5 | oneline)"
    return 1
  fi

  apply_update "$head" "$target" "$label" 0
}

main "$@"; exit $?
