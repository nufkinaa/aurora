#!/usr/bin/env bash
# The website's browser tests on GitHub (.github/workflows/ui.yml), per shard,
# from the public API — so an agent can wait for GitHub instead of the local
# ui-lock. They run on every push to master, rel-* and ui-* branches.
#
#   tools/ci-ui.sh <branch>                  # the latest UI run of that branch
#   tools/ci-ui.sh <branch> --sha <commit>   # the run of that commit
#   tools/ci-ui.sh <branch> --wait           # poll (every 120 s) until it ends
#
# Exit: 0 green, 1 red, 3 still running (without --wait), 2 no answer.
# A branch that is not master / rel-* / ui-* gets a run by pushing it under a
# ui-* name as well:  git push origin HEAD:ui-<your-branch>
exec node "$(dirname "$0")/ci/ci-ui.js" "$@"
