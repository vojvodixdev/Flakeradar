# How FlakeRadar scores tests

All of this lives in [`packages/core/src/scoring.ts`](../packages/core/src/scoring.ts)
as a single pure function, `analyzeFlakiness(samples)`. The server calls it for
every test touched by a new run, with that test's last 300 executions.

## Input

Each sample is one execution of one test:

| Field | Meaning |
|---|---|
| `status` | `passed` or `failed` (skipped executions carry no signal and are left out) |
| `commitSha` | The commit that was tested |
| `at` | When it ran, used for ordering |
| `trusted` | `true` when it ran on the project's default branch |

Retries matter. When a runner retries a failed test (Playwright `retries`,
Maven Surefire `rerunFailingTestsCount`, pytest-rerunfailures) the JUnit report
contains several attempts, and the parser turns each one into its own sample.
Surefire's `<flakyFailure>` and `<rerunFailure>` elements are understood too.

## Evidence 1: same commit, different outcome

```
conflictingCommits = number of commits with at least one pass and one fail
conflictEvidence   = 1 − 0.5 ^ conflictingCommits
```

One such commit gives 0.5, two give 0.75, three give 0.875. The code did not
change between those executions, so there is no innocent explanation. This
counts on every branch, including pull requests.

## Evidence 2: flip rate on the default branch

Take the trusted samples in time order and compare each with the previous one,
skipping pairs that share a commit (those are already counted above):

```
flips       = pairs whose outcomes differ
comparisons = pairs compared
flipEvidence = clamp( wilsonLower(flips, comparisons) / 0.15, 0, 1 )
```

`wilsonLower` is the lower bound of a one-sided 95% Wilson score interval
(z = 1.645). It answers "what is the lowest flip rate we can be fairly sure
of?", which keeps small samples from producing extreme scores:

| Flips / comparisons | Raw rate | Wilson lower bound |
|---|---|---|
| 2 / 2 | 100% | 42% |
| 10 / 99 | 10% | 6% |
| 20 / 99 | 20% | 14% |

A test that fails at random with probability *p* flips about 2·p·(1−p) of the
time, so 0.15 is reached by anything that fails roughly one run in ten. That is
where the evidence saturates.

Feature branches are left out on purpose. On a branch the author changes the
code between pushes, so "failed, then passed" usually means "I fixed my bug".

## Combining them

The two signals are treated as independent evidence. The test is "not flaky"
only if neither says it is:

```
score = 1 − (1 − conflictEvidence) · (1 − flipEvidence)
```

## Labels

Checked in this order:

| Label | Rule |
|---|---|
| `broken` | The last 3 or more default-branch runs failed, and none of those commits ever passed |
| `new` | Fewer than 5 runs and no same-commit conflict yet |
| `flaky` | score ≥ 0.6 |
| `suspect` | score ≥ 0.25 |
| `stable` | everything else |

`broken` wins over `flaky` deliberately: if a test that used to be flaky now
fails every time, the useful message is "this is broken right now".

## Worked examples

These are real outputs of `analyzeFlakiness`, one run per commit on the
default branch (`P` pass, `F` fail).

| History | Label | Score | Why |
|---|---|---|---|
| `P` × 40, then `FFFFF` | broken | 0.01 | One flip, then a deterministic failure streak |
| `P` × 30, `FFF`, `P` × 30 | stable | 0.07 | A bug was introduced and fixed: two flips in 62 comparisons |
| `PPPPPPPPPF` | stable | 0.17 | One failure is not enough to call it flaky |
| 100 runs, fails 5% of the time | suspect | 0.41 | 10 flips in 99, a real but weak signal |
| 100 runs, fails 10% of the time | flaky | 0.96 | 20 flips in 99 |
| Fail and pass on one commit | suspect | 0.50 | One same-commit conflict |
| Fail and pass on two commits | flaky | 0.75 | Two same-commit conflicts |

## Pull request verdicts

For each failed test in a new run, [`verdictFor`](../packages/core/src/verdict.ts)
picks one of:

| Verdict | When | Blocks? |
|---|---|---|
| Flaky: passed on retry | The same test also passed in this run | No |
| Known flaky | Was `flaky` before this run | No |
| Possibly flaky | Was `suspect` | Yes |
| Already broken | Was `broken` | Yes |
| Likely regression | Was `stable` or `new` | Yes |

Quarantined tests never block, whatever their verdict.

The status used here is the one stored *before* the run was ingested. Using
the updated status would let a PR that breaks a test several pushes in a row
turn its own regression into "already broken".

## Known limits

- Tests are identified by `classname::name`. Renaming a test starts a new history.
- A test that is flaky only on one OS or shard is scored across all of them.
  Splitting history by job name is on the roadmap.
- Order-dependent tests (that fail only after a specific other test) look
  flaky, which is usually the right call, but the score cannot say *why*.
