# Uptimely Monitors GitHub Action

Use [Uptimely](https://getuptimely.com) monitors from your GitHub workflows:

- **Quiet deploys.** Mute monitors (by id or by label) while a deploy runs and unmute them afterwards, so your own deploy does not page on-call. Checks keep running, so uptime numbers and status pages stay accurate.
- **A monitor per preview.** Create a monitor for each pull request's preview URL, reuse it on every push, and delete it when the PR closes.
- **Post-deploy gate.** Fail the job if a monitor is not up within a timeout.

| `operation` | What it does | Uptimely endpoints |
|---|---|---|
| `mute` | Mutes alerting on the selected monitors for `mute-minutes` | `POST /v1/monitors/{id}/mute` |
| `unmute` | Lifts the mute. Safe in an `if: always()` step | `DELETE /v1/monitors/{id}/mute` |
| `create-preview-monitor` | Creates a Website/API monitor for `url`, or reuses the one this action made in an earlier run | `GET /v1/monitors`, `GET /v1/monitors/export`, `POST /v1/monitors`, `PATCH /v1/monitors/{id}`, `DELETE /v1/monitors/{id}` (duplicates) |
| `delete-monitor` | Deletes a monitor by id, or every monitor this action made under a name. Nothing to delete counts as success | `DELETE /v1/monitors/{id}` |
| `check` | Waits for Uptimely's next check of a monitor and passes when it is up, or fails at `timeout-seconds` | `GET /v1/monitors/{id}` |

### Why mute and not pause

Uptimely's API has no pause on purpose. Pausing stops the checks, which leaves gaps in your uptime record and your status page. A mute keeps the checks running and only stops incidents and alerts. The mute also ends by itself after `mute-minutes`, so a cancelled run never leaves monitors silenced for good.

## Setup

1. In Uptimely, open **Settings → API Keys → Public API keys** in the project that owns the monitors and create a key. It starts with `uptimely_live_` and belongs to that one project.
2. Give the key the scopes the operations need:

   | Operation | Scopes |
   |---|---|
   | `check` | `monitors:read` |
   | `mute`, `unmute` | `monitors:write`, plus `monitors:read` when you select by `labels` |
   | `create-preview-monitor` | `monitors:read`, `monitors:write` |
   | `delete-monitor` | `monitors:write`, plus `monitors:read` when you select by `name` |

3. Writes (`mute`, `unmute`, `create-preview-monitor`, `delete-monitor`) need the **Pro** plan and the project's **Allow AI write operations** switch, on the same settings page. `check` works on every plan.
4. Store the key as a repository or organization secret, e.g. `UPTIMELY_API_KEY`.

Every call counts against the project's monthly API allowance (Free 1,000, Pro 100,000). A `check` makes one request per poll, so the defaults (`interval-seconds: 15`, `timeout-seconds: 900`) make at most 60 requests.

### GitHub permissions

The action calls only the Uptimely API. It does not use `GITHUB_TOKEN`, so the job can run with no token permissions at all:

```yaml
permissions: {}
```

(`actions/checkout` in the same job needs `contents: read`.)

## Example: mute monitors during a deploy

```yaml
name: Deploy
on:
  push:
    branches: [main]

permissions:
  contents: read

# One production deploy at a time: see "Overlapping deploys" below.
concurrency:
  group: production-deploy
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Mute production monitors
        id: mute
        uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: mute
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
          labels: production            # and/or monitor-ids: id1,id2
          mute-minutes: 20              # expires on its own if unmute never runs

      - name: Deploy
        run: ./deploy.sh

      - name: Wait until the site is up
        uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: check
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
          monitor-id: ${{ vars.UPTIMELY_SITE_MONITOR_ID }}
          timeout-seconds: 900            # at least two of the monitor's check intervals

      - name: Unmute
        if: always()
        uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: unmute
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
          labels: production
          fail-on-error: false            # an Uptimely outage must not turn a good deploy red
```

The unmute step repeats the same selector instead of reading `steps.mute.outputs.monitor-ids`, so it still unmutes everything if the mute step stopped halfway. Unmuting a monitor that is not muted does nothing, and a monitor deleted in the meantime only produces a warning. `unmute` fails only when a monitor could not be unmuted, and that monitor's mute still ends at `mute-minutes`. With `fail-on-error: false` that failure (for example a 5xx, a `429` or a `403` that outlasted the retries) is reported as a warning instead, so the deploy job stays green.

### Overlapping deploys

Muting is per monitor, not per deploy. If two deploys of the same monitors overlap, the second `mute` replaces the first one's window, and whichever deploy finishes first unmutes the monitors while the other is still running, so the rest of that deploy can page. Run one deploy at a time with a `concurrency` group (as above, with `cancel-in-progress: false` so a running deploy is never killed between `mute` and `unmute`). If deploys must overlap, give each its own labels, or drop the `unmute` step and let the mute expire after `mute-minutes`.

## Example: a monitor per pull-request preview

```yaml
name: Preview monitor
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read

# One run per PR at a time; a newer push cancels the older run.
concurrency:
  group: uptimely-preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  monitor:
    # Fork PRs get no secrets, so skip them (see "Pull requests from forks").
    if: github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      # ... deploy the preview and get its URL, e.g. from your platform's action
      - name: Monitor the preview
        id: preview
        uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: create-preview-monitor
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
          url: ${{ steps.deploy.outputs.preview-url }}
          monitoring-interval: "*/5 * * * *"

      - name: Gate on the preview being up
        uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: check
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
          monitor-id: ${{ steps.preview.outputs.monitor-id }}
          # waits for Uptimely's next check of the preview,
          # so allow at least two monitoring intervals
          timeout-seconds: 900

  cleanup:
    if: github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Delete the preview monitor
        uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: delete-monitor
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
```

On `pull_request` events the monitor is named `<owner>/<repo> PR #<number> preview` (a long repository name is shortened; the PR number is always kept). Its description ends with an ownership marker, `[uptimely-action:<owner>/<repo>#<number>]`, and the action only reuses, re-points or deletes monitors that carry the marker for the same repository and PR:

- Every push to the PR reuses the same monitor (`created: false`). If the preview URL changed, the monitor is pointed at the new one (`updated: true`).
- A monitor this action made for the PR that already watches the same URL is reused rather than duplicated.
- A monitor with the same name but without the marker (one you made by hand, say) is never changed: the step fails and asks you to rename or delete it.
- The create call's `Idempotency-Key` is derived from the repository, the PR and the request, so retries and concurrent runs for the same URL create one monitor. If concurrent runs with different URLs still create two, each run keeps the oldest marked monitor and deletes the others. The `concurrency` group above keeps that rare.
- On close, `delete-monitor` deletes every marked monitor with that name. If none is left, the step succeeds with `deleted: false`.

Set `name` to use your own naming. It must then be the same in both jobs.

### Pull requests from forks

GitHub does not pass repository secrets to `pull_request` runs from forks, so `api-key` is empty there and the step would fail. The example skips fork PRs with the `head.repo.full_name` condition. Do not switch to `pull_request_target` to get the secret: that runs with your secrets next to the fork's untrusted code.

## Example: post-deploy gate only

```yaml
      - uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: check
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
          name: Marketing site            # or monitor-id
          up-statuses: Operational        # comma-separated; add Degraded to accept it
          timeout-seconds: 900
          interval-seconds: 15
```

Uptimely has no "check this URL now" endpoint, so `check` waits for the monitor's own scheduled checks. By default it only trusts a status Uptimely recorded after the step started (`wait-for-new-check: true`): a brand-new monitor reads Operational before its first check, and a monitor whose URL was just changed keeps the old URL's status until it is checked again. The API has no last-check time, so the action watches `updated_at`, which Uptimely's checker writes when it picks the monitor up and again once the result is stored. Because the API only shows the latest of those writes, the step can need one or two check intervals (5 to 10 minutes at the default cadence), so keep `timeout-seconds` at least twice the monitor's `monitoring-interval`. For a monitor type that is not checked on a schedule (Manual, Incoming Request, Incoming Email), set `wait-for-new-check: false`.

If a check was already running when a preview's URL was changed, its result for the old URL can still be the one the step sees. Add `stable-for-seconds` of one check interval to rule that out. A monitor with active monitoring switched off (paused, or in a maintenance window) fails the step at once.

## Inputs

| Input | Used by | Default | Description |
|---|---|---|---|
| `operation` | all | (required) | `mute`, `unmute`, `create-preview-monitor`, `delete-monitor` or `check` |
| `api-key` | all | (required) | Uptimely project API key. Masked in logs |
| `api-url` | all | `https://app.getuptimely.com` | API base URL (must be https) |
| `fail-on-error` | all | `true` | `false` reports an error as a warning and keeps the step green |
| `monitor-ids` | mute, unmute | | Monitor ids, comma- or newline-separated |
| `labels` | mute, unmute | | Label names. Selects every monitor that carries one of them |
| `mute-minutes` | mute | `30` | Length of the mute window (1-43200) |
| `url` | create-preview-monitor | | Preview URL to monitor |
| `name` | create, delete, check | PR-based name | Monitor name. Create and delete only touch monitors with this name that carry the ownership marker |
| `monitor-type` | create, delete | `Website` | `Website` or `API`. For delete, an optional filter |
| `description` | create-preview-monitor | generated | Monitor description. The ownership marker is always appended |
| `monitoring-interval` | create-preview-monitor | Uptimely default (`*/5 * * * *`) | Cron-shaped check cadence |
| `failure-threshold` | create-preview-monitor | Uptimely default (2) | Consecutive failed checks before an incident (1-10) |
| `monitor-id` | delete, check | | Monitor id. Takes precedence over `name` |
| `timeout-seconds` | check | `900` | Give up after this many seconds. At least twice the monitor's check interval |
| `interval-seconds` | check | `15` | Seconds between polls (min 5) |
| `up-statuses` | check | `Operational` | Status names that count as up |
| `stable-for-seconds` | check | `0` | How long the monitor must stay up before the step passes |
| `wait-for-new-check` | check | `true` | Only trust a status recorded after the step started |

## Outputs

| Output | Set by | Description |
|---|---|---|
| `monitor-id` | create, delete, check | The monitor id (delete: the first one deleted) |
| `monitor-ids` | mute, unmute, delete | Comma-separated ids that were muted / unmuted / deleted |
| `monitor-name` | create-preview-monitor | The name used |
| `created` | create-preview-monitor | `true` if created, `false` if reused |
| `updated` | create-preview-monitor | `true` if a reused monitor's URL was changed |
| `deleted` | delete-monitor | `true` if deleted, `false` if there was nothing to delete |
| `muted-until` | mute | When the mute ends (ISO-8601 UTC) |
| `status` | check | Last observed status name |

## Errors and retries

- Errors carry Uptimely's own message and request id, e.g. `Uptimely POST /v1/monitors failed (403 feature_not_enabled): ...`. With `fail-on-error: false` the step logs them as a warning and stays green.
- Only calls that are safe to repeat are retried: GETs, DELETEs, the URL `PATCH`, and POSTs sent with an `Idempotency-Key` (create, mute). They are retried up to 4 times with exponential backoff on network errors, 5xx and a burst `429 rate_limited`, and `Retry-After` is honoured up to 60 seconds. A `429 quota_exhausted` (monthly allowance used up) is not retried.
- Selecting by label joins the config export (which has label names) with the monitor list (which has ids) on name and type. If several monitors share a name and type and only some of them have the label, the step fails rather than guess. Use `monitor-ids` in that case.

## Development

```sh
npm ci
npm test          # vitest, HTTP mocked
npm run build     # bundles src/ into dist/ with @vercel/ncc
```

`dist/` is committed because GitHub runs the action straight from the repository. CI fails if `dist/` does not match the source.

## Releasing

Releases follow semantic versioning. After a change lands on `main` with CI green, tag it and move the major tag so `@v1` picks it up:

```sh
git tag -a v1.2.3 -m "v1.2.3" && git push origin v1.2.3
git tag -f v1 v1.2.3 && git push -f origin v1
```

Then create the GitHub Release for the new tag, which updates the Marketplace listing.

## License

[MIT](LICENSE)
