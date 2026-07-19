# Deployment & runner fleet

How Luke's ClawSweeper fork is deployed and how to operate the self-hosted runner
fleet. Prefer the **runtime checks** in each section over memorising host facts —
the cluster changes and static lists go stale. Host/IP details live in
`~/Projects/agent-scripts/devices.md`, not here.

## What runs where

- **Code + Actions:** `valkyriweb/clawsweeper` (this repo) runs the sweep/review/repair workflows.
- **State:** `valkyriweb/clawsweeper-state` (published review state, dashboards).
- **Targets:** the fleet in [`config/target-repositories.json`](../config/target-repositories.json).
- **GitHub Apps:** target token authority is explicit in each repository profile's
  `github_app_credential_route`. `valkyriweb` routes use `valkyriweb-clawsweeper`
  (Personal vault); `bermont-digital` routes use `bermont-clawsweeper` from the
  Bermont Digital vault, with both credentials held only by this engine repository.
  The static target-token facade never infers an App from target ownership, and state
  plus Pi package tokens always use the Valkyriweb App.

Check live app installs:

```bash
# needs the app JWT; key is in 1Password (op item get / op read)
gh api repos/valkyriweb/clawsweeper/actions/secrets --jq '.secrets[].name'  # confirms APP_PRIVATE_KEY secret is set
```

## gh vs ghx — default native gh, ghx only after env-forwarding fix

Luke's self-hosted runners may shim `gh` → **ghx** (a gh cache proxy) for openclaw.
ClawSweeper historically bypassed ghx because older ghx daemons inherited one
startup identity and ignored per-call `GH_TOKEN`:

> ClawSweeper passes a *scoped per-target* token. Old ghx executed daemon-side
> `gh` subprocesses with the daemon's startup environment, so private targets could
> resolve as unauthenticated and return **404** (for example the
> `valkyriweb/lue-kube` failures on 2026-05-29).

Safe baseline: `sweep.yml` sets `GH_BIN` to a real gh (upstream-supported override
— see `src/command.ts`, `src/clawsweeper.ts`). Each runner host has a stable
`/usr/local/bin/gh-native` symlink → real gh:

```bash
# verify the native baseline on a host (must print real gh, not the ghx shim)
ssh <host> '/usr/local/bin/gh-native --version; readlink /usr/local/bin/gh-native'
# create it if missing (target = the host's real gh: apt /usr/bin/gh, or ghx's ~/.ghx/bin/gh)
ssh <host> 'sudo ln -sf /usr/bin/gh /usr/local/bin/gh-native'   # Linux w/ apt gh
```

### Current state (resolved 2026-07-19, #197)

The env-forwarding fix shipped: **ghx fork ≥ v1.7.0** adopts upstream `authenv`
(brunoborges/ghx#18) so the per-call `GH_TOKEN` is captured → applied → the
cache/singleflight is isolated by token fingerprint. The scoped checks token is
forwarded to `gh` instead of the daemon's cached auth, so `Publish commit check`
no longer 403s.

Rollout shape **1** (fleet-wide) is live:

- Fixed `ghx`+`ghxd` (v1.7.0 build) installed at `/usr/local/bin/{ghx,ghxd}` on
  every Linux self-hosted host (`old-mbp`, `x99`) and at
  `/Users/luke/.local/bin/{ghx,ghxd}` on the `mac-mini` (its `/usr/local/bin/ghx`
  is a symlink to that). Deploy each ghx **next to** its ghxd — `findGHXD` prefers
  the dir-adjacent daemon over PATH, so the fixed daemon is always used.
- Repo var `CLAWSWEEPER_GH_BIN=/usr/local/bin/ghx` is set (resolves `GH_BIN`).
- Old binaries are backed up as `ghx.bak-20260719` next to each install (rollback).

```bash
# deploy the fixed pair to a Linux runner host (backup, stop stale daemon, install)
scp ghx ghxd luke@<host>:/tmp/
ssh luke@<host> 'sudo cp -a /usr/local/bin/ghx /usr/local/bin/ghx.bak-$(date +%Y%m%d); \
  pkill -x ghxd || true; \
  sudo install -m755 /tmp/ghx /usr/local/bin/ghx && sudo install -m755 /tmp/ghxd /usr/local/bin/ghxd'
# repo var (already set)
gh variable set CLAWSWEEPER_GH_BIN --repo valkyriweb/clawsweeper --body /usr/local/bin/ghx
# rollback: restore the .bak and delete the var
gh variable delete CLAWSWEEPER_GH_BIN --repo valkyriweb/clawsweeper
```

**Critical caveat — GitHub-hosted jobs must NOT inherit the ghx path.** The
repo-wide `CLAWSWEEPER_GH_BIN` resolves `GH_BIN` at the *workflow* level, so it
leaks into GitHub-hosted `ubuntu-latest` jobs (e.g. the `Commit reports` job)
where `/usr/local/bin/ghx` does not exist → `spawnSync ENOENT`. Those jobs pin
`GH_BIN: gh` at the job level to use the runner's PATH-resolved native gh (#200).
Self-hosted review jobs also reset `commit-artifacts`/`commit-work` before each
run so stale cross-repo reports are not swept into the aggregate publish (#201).

Do **not** point ClawSweeper at old ghx builds (pre-v1.7.0) — they drop the
per-call token. Native gh remains the rollback/default.

## Runner fleet & job distribution

Runners are selected by `runs-on`, driven by repo variables:

| Variable | Controls | Current value |
|---|---|---|
| `CLAWSWEEPER_RUNNER_LABELS` | general pool (plan/apply/audit) | `["self-hosted","lue-clawsweeper"]` |
| `CLAWSWEEPER_REVIEW_RUNNER` | heavy Codex **review shards** only | `["self-hosted","macOS","ARM64","mac-mini"]` |

The shared label **`lue-clawsweeper`** spans the mac-mini pool **and** the Linux
boxes (old-mbp, x99). Review shards are pinned to the mac-mini so the **lue-kube
cluster nodes (x99, old-mbp) only take light jobs** — they are production cluster
workers, keep heavy Codex/token load off them.

Check the live fleet (don't trust a static list):

```bash
gh api repos/valkyriweb/clawsweeper/actions/runners \
  --jq '.runners[]|"\(.name)\t\(.status)\tbusy=\(.busy)\t"+([.labels[].name]|join(","))'
gh variable list --repo valkyriweb/clawsweeper | grep -E 'RUNNER_LABELS|REVIEW_RUNNER'
```

Activity & worker health: use the `clawsweeper-status` skill —
`~/Projects/agent-scripts/skills/clawsweeper-status/scripts/clawsweeper-status.sh --all-targets`.

## Add a self-hosted runner

On a host that already runs an openclaw runner (clone its binaries, configure fresh):

```bash
REG=$(gh api -X POST repos/valkyriweb/clawsweeper/actions/runners/registration-token --jq .token)
ssh <host> "
  cd ~ && cp -a actions-runner-openclaw actions-runner-clawsweeper
  cd actions-runner-clawsweeper
  rm -rf _work _diag _update .runner .credentials .credentials_rsaparams .service .runner_migrated
  ./config.sh --url https://github.com/valkyriweb/clawsweeper --token $REG \
    --name <host>-clawsweeper --labels lue-clawsweeper --unattended --replace
  sudo ./svc.sh install \$(whoami) && sudo ./svc.sh start
"
# then ensure /usr/local/bin/gh-native exists (see gh vs ghx section)
```

One runner instance per host = one concurrent job (deliberate, for resource caution).
To add an existing mac-mini runner to the shared pool without reconfiguring:

```bash
id=$(gh api repos/valkyriweb/clawsweeper/actions/runners --jq '.runners[]|select(.name=="<name>")|.id')
gh api -X POST repos/valkyriweb/clawsweeper/actions/runners/$id/labels -f 'labels[]=lue-clawsweeper'
```

Runner service control on a host:

```bash
ssh <host> 'sudo systemctl status actions.runner.valkyriweb-clawsweeper.<name>.service'
```

## Autoscaling pool (ARC on lue-kube)

Beyond the static self-hosted runners, an **autoscaling pod pool** runs on the lue-kube
cluster via [ARC](https://github.com/actions/actions-runner-controller) (actions-runner-controller).
It registers to this repo with `runnerScaleSetName: lue-clawsweeper` — i.e. it joins the same
`lue-clawsweeper` pool as the mac-mini/Linux runners, so `CLAWSWEEPER_RUNNER_LABELS` already
targets it. Scales **0 → 6** on queued jobs, scale-to-zero when idle, balanced ~3/node across
the x99 + old-mbp workers.

- Manifests live in the **cluster repo**, not here: `infra/lue-kube/k3s/apps/github-runners/`
  (`base/clawsweeper-scaleset.yaml`) + controller in `k3s/infrastructure/controllers/actions-runner-controller/`.
  See that app's `README.md`.
- Auth: GitHub App `valkyriweb-clawsweeper` (sealed secret), not a PAT.
- Runner image: the cluster's `github-ai-runner` (already `FROM ghcr.io/actions/actions-runner`
  + codex/pi/gh, native gh). ClawSweeper defaults `GH_BIN=/usr/local/bin/gh-native` in-pod
  via a baked symlink. If ghx is trialed again, the image/host must include the env-forwarding
  ghx fork release and `CLAWSWEEPER_GH_BIN` must point at that binary.
- **Codex-free pool**: ARC pods take light jobs (plan/apply/audit) only. Heavy Codex review
  stays pinned to the mac-mini (`CLAWSWEEPER_REVIEW_RUNNER`) because review needs the
  mac-mini's ChatGPT-subscription `~/.codex/auth.json`, which ephemeral pods don't have.

```bash
# pool state (run against lue-kube context)
kube lue-kube arc-systems     -- get pods                      # controller
kube lue-kube github-runners  -- get autoscalingrunnerset,ephemeralrunner,pods
gh api repos/valkyriweb/clawsweeper/actions/runners --jq '.runners[]|select(.name|test("lue-clawsweeper"))|{name,status}'
```

### Why this shape (and a note on planning infra here)

We set out to build ARC greenfield, then found lue-kube **already had** a GitOps
`github-runners` app + a custom runner image with the whole toolchain, and a README that
had pre-decided "StatefulSet now, ARC when a pool is needed." The build collapsed into
*extend the existing app*, not *stand up a parallel stack*. **Lesson:** before designing
cluster infra, read the target cluster repo's app dir + README + Flux wiring — the live shape
often reshapes the plan.

## Pause / resume / emergency stop

Pausing points `runs-on` at a label no runner has, so jobs queue instead of running.
Full ladder and safe target order: [`safe-ramp-valkyriweb.md`](safe-ramp-valkyriweb.md).

```bash
# pause (queue everything)
gh variable set CLAWSWEEPER_RUNNER_LABELS --repo valkyriweb/clawsweeper --body '["self-hosted","clawsweeper-paused"]'
# resume to the shared pool
gh variable set CLAWSWEEPER_RUNNER_LABELS --repo valkyriweb/clawsweeper --body '["self-hosted","lue-clawsweeper"]'
```

## Verify a target after a change

```bash
gh workflow run sweep.yml --repo valkyriweb/clawsweeper -f target_repo=valkyriweb/lue-kube
RID=$(gh api repos/valkyriweb/clawsweeper/actions/workflows/sweep.yml/runs --jq '.workflow_runs[0].id')
gh api repos/valkyriweb/clawsweeper/actions/runs/$RID/jobs \
  --jq '.jobs[]|select(.name|test("Plan"))|"\(.status)/\(.conclusion)\trunner=\(.runner_name)"'
```

A green **Plan review candidates** step confirms the scoped token + gh-native path
(it is the step that 404s when ghx is in the way).
