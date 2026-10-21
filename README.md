# Uptimely Monitors GitHub Action

Use [Uptimely](https://getuptimely.com) monitors from your GitHub workflows:

- **Quiet deploys.** Mute monitors (by id or by label) while a deploy runs and unmute them afterwards, so your own deploy does not page on-call. Checks keep running, so uptime numbers and status pages stay accurate.
- **A monitor per preview.** Create a monitor for each pull request's preview URL, reuse it on every push, and delete it when the PR closes.
- **Post-deploy gate.** Fail the job if a monitor is not up within a timeout.

| `operation` | What it does | Uptimely endpoints |
|---|---|---|
| `mute` | Mutes alerting on the selected monitors for `mute-minutes` | `POST /v1/monitors/{id}/mute` |
| `unmute` | Lifts the mute. Safe in an `if: always()` step | `DELETE /v1/monitors/{id}/mute` |
| `create-preview-monitor` | Creates a Website/API monitor for `url`, or reuses the one from an earlier run | `GET /v1/monitors`, `GET /v1/monitors/export`, `POST /v1/monitors`, `PATCH /v1/monitors/{id}` |
| `delete-monitor` | Deletes a monitor by id or name. A monitor that is already gone counts as success | `DELETE /v1/monitors/{id}` |
| `check` | Polls a monitor until its status is up, or fails at `timeout-seconds` | `GET /v1/monitors/{id}` |

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

Every call counts against the project's monthly API allowance (Free 1,000, Pro 100,000). A `check` makes one request per poll, so the defaults (`interval-seconds: 15`, `timeout-seconds: 600`) make at most 40 requests.

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
          timeout-seconds: 300

      - name: Unmute
        if: always()
        uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: unmute
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
          labels: production
```

The unmute step repeats the same selector instead of reading `steps.mute.outputs.monitor-ids`, so it still unmutes everything if the mute step stopped halfway. Unmuting a monitor that is not muted does nothing, and a monitor deleted in the meantime only produces a warning. `unmute` fails only when a monitor could not be unmuted, and that monitor's mute still ends at `mute-minutes`.

## Example: a monitor per pull-request preview

```yaml
name: Preview monitor
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read

jobs:
  monitor:
    if: github.event.action != 'closed'
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
          # a new monitor reads Operational before its first check:
          # require one full interval of "up" to be sure a probe ran
          stable-for-seconds: 330
          timeout-seconds: 900

  cleanup:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - name: Delete the preview monitor
        uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: delete-monitor
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
```

On `pull_request` events the monitor is named `<owner>/<repo> PR #<number> preview`. That makes it idempotent:

- Every push to the PR reuses the same monitor (`created: false`). If the preview URL changed, the monitor is pointed at the new one (`updated: true`).
- A monitor that already watches the same URL is reused rather than duplicated.
- The create call carries an `Idempotency-Key`, so a retried request cannot create a second monitor.
- On close, `delete-monitor` finds the monitor by the same name. If it is already gone, the step succeeds with `deleted: false`.

Set `name` to use your own naming. It must then be the same in both jobs.

## Example: post-deploy gate only

```yaml
      - uses: DevinoSolutions/uptimely-action@v1
        with:
          operation: check
          api-key: ${{ secrets.UPTIMELY_API_KEY }}
          name: Marketing site            # or monitor-id
          up-statuses: Operational        # comma-separated; add Degraded to accept it
          timeout-seconds: 600
          interval-seconds: 15
```

Uptimely has no "check this URL now" endpoint, so `check` waits for the monitor's own scheduled checks. Set its cadence (`monitoring-interval`) to match how long you are willing to wait.

## Inputs

| Input | Used by | Default | Description |
|---|---|---|---|
| `operation` | all | (required) | `mute`, `unmute`, `create-preview-monitor`, `delete-monitor` or `check` |
| `api-key` | all | (required) | Uptimely project API key. Masked in logs |
| `api-url` | all | `https://app.getuptimely.com` | API base URL (must be https) |
| `monitor-ids` | mute, unmute | | Monitor ids, comma- or newline-separated |
| `labels` | mute, unmute | | Label names. Selects every monitor that carries one of them |
| `mute-minutes` | mute | `30` | Length of the mute window (1-43200) |
| `url` | create-preview-monitor | | Preview URL to monitor |
| `name` | create, delete, check | PR-based name | Monitor name |
| `monitor-type` | create, delete | `Website` | `Website` or `API`. For delete, an optional filter |
| `description` | create-preview-monitor | generated | Monitor description |
| `monitoring-interval` | create-preview-monitor | Uptimely default (`*/5 * * * *`) | Cron-shaped check cadence |
| `failure-threshold` | create-preview-monitor | Uptimely default (2) | Consecutive failed checks before an incident (1-10) |
| `monitor-id` | delete, check | | Monitor id. Takes precedence over `name` |
| `timeout-seconds` | check | `600` | Give up after this many seconds |
| `interval-seconds` | check | `15` | Seconds between polls (min 5) |
| `up-statuses` | check | `Operational` | Status names that count as up |
| `stable-for-seconds` | check | `0` | How long the monitor must stay up before the step passes |

## Outputs

| Output | Set by | Description |
|---|---|---|
| `monitor-id` | create, delete, check | The monitor id |
| `monitor-ids` | mute, unmute | Comma-separated ids that were muted / unmuted |
| `monitor-name` | create-preview-monitor | The name used |
| `created` | create-preview-monitor | `true` if created, `false` if reused |
| `updated` | create-preview-monitor | `true` if a reused monitor's URL was changed |
| `deleted` | delete-monitor | `true` if deleted, `false` if there was nothing to delete |
| `muted-until` | mute | When the mute ends (ISO-8601 UTC) |
| `status` | check | Last observed status name |

## Errors and retries

- Errors carry Uptimely's own message and request id, e.g. `Uptimely POST /v1/monitors failed (403 feature_not_enabled): ...`.
- Only calls that are safe to repeat are retried: GETs, DELETEs, the URL `PATCH`, and POSTs sent with an `Idempotency-Key` (create, mute). They are retried up to 4 times with exponential backoff on network errors, 5xx and a burst `429 rate_limited`, and `Retry-After` is honoured up to 60 seconds. A `429 quota_exhausted` (monthly allowance used up) is not retried.
- Selecting by label joins the config export (which has label names) with the monitor list (which has ids) on name and type. If several monitors share a name and type and only some of them have the label, the step fails rather than guess. Use `monitor-ids` in that case.

## Development

```sh
npm ci
npm test          # vitest, HTTP mocked
npm run build     # bundles src/ into dist/ with @vercel/ncc
```

`dist/` is committed because GitHub runs the action straight from the repository. CI fails if `dist/` does not match the source.

## Publishing (owner step)

The steps below are not done. They need the owner (Devino org admin):

1. **Create the public repository** `DevinoSolutions/uptimely-action` and push `main`. The Marketplace only lists actions from public repos with a single `action.yml` at the root.
2. **Choose a license** and add a `LICENSE` file before the first release. The repo has none yet; this is a legal decision for the owner.
3. **Check that the action name is free.** `name:` in `action.yml` ("Uptimely Monitors") must not match an existing Marketplace action, a category, or a GitHub user or org that Devino does not own. Rename it if the release page complains.
4. **Accept the GitHub Marketplace Developer Agreement** for the DevinoSolutions org. An org owner does this from the link on the release page. Two-factor authentication must be on for the publishing account.
5. **Release v1.0.0 with "Publish this Action to the GitHub Marketplace" ticked.** Pick a primary category (Monitoring; second category Deployment). Then create or move the major tag so `@v1` works:
   ```sh
   git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0
   git tag -f v1 v1.0.0 && git push -f origin v1
   ```
6. **Live-test before announcing it.** Run the three example workflows in a test repo against a Pro Uptimely project that has write operations on. Listing is immediate and GitHub does not review it, so this test is the only review.

Docs: <https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace>
