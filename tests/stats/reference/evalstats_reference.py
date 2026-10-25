# Generates tests/stats/reference/evalstats-fixtures.json, the reference values for the binary methods in
# src/stats (Wilson, Wilson on per-case rates, Bonett-Price single-run and case-clustered, McNemar mid-p,
# p-value by interval inversion, Sidak, Shaffer) and for ICC(1) and unbiased pass^k.
#
# Run from the repository root, by hand, never in CI:
#   uv run --no-project --python 3.12 --with evalstats==0.3.3 --with numpy==2.5.4 --with scipy==1.18.1 \
#     python -I tests/stats/reference/evalstats_reference.py
#
# Every value except ICC(1) and pass^k comes from evalstats' own functions, imported below. ICC(1) and
# pass^k are not evalstats methods; they are computed here with an independent numpy / math.comb
# implementation of the textbook formulas. The output records the versions and this script's sha256.
import hashlib
import json
import math
import platform
import sys
from pathlib import Path

import numpy as np
import scipy

import evalstats
from evalstats.core.paired import _p_value_by_inversion
from evalstats.core.resampling import (
    bonett_price_paired_ci,
    bonett_price_paired_ci_multirun_cluster,
    wilson_ci,
    wilson_ci_1d,
)
from evalstats.core.stats_utils import _shaffer_adjusted_pvalues
from evalstats.tests import _mcnemar_midp_p

SCRIPT = Path(__file__)
OUTPUT = SCRIPT.with_name("evalstats-fixtures.json")
RNG = np.random.default_rng(20261024)


def paired_arrays(first_only, second_only, both_passed, both_failed):
    a = [1] * first_only + [0] * second_only + [1] * both_passed + [0] * both_failed
    b = [0] * first_only + [1] * second_only + [1] * both_passed + [0] * both_failed
    return np.array(a, dtype=float), np.array(b, dtype=float)


def wilson_cases():
    out = []
    for successes, n in [(0, 1), (1, 1), (0, 15), (15, 15), (7, 15), (27, 30), (0, 30), (30, 30), (45, 90), (88, 90), (3, 300)]:
        for confidence in (0.95, 0.99, 0.9):
            low, high = wilson_ci(successes, n, 1 - confidence)
            out.append({"successes": successes, "trials": n, "confidence": confidence, "low": low, "high": high})
    return out


def wilson_rate_cases():
    out = []
    for n, repeats in [(15, 5), (30, 5), (90, 5), (30, 3)]:
        rates = (RNG.binomial(repeats, RNG.uniform(0.2, 1.0, size=n)) / repeats).tolist()
        low, high = wilson_ci_1d(np.array(rates), 0.05)
        out.append({"rates": rates, "confidence": 0.95, "low": low, "high": high})
    out.append({"rates": [1.0] * 30, "confidence": 0.95, "low": wilson_ci_1d(np.ones(30), 0.05)[0], "high": wilson_ci_1d(np.ones(30), 0.05)[1]})
    return out


def bonett_price_cases():
    tables = [
        (0, 0, 30, 0), (0, 0, 90, 0), (0, 0, 0, 30), (1, 0, 29, 0), (0, 1, 29, 0), (3, 1, 20, 6),
        (1, 7, 15, 7), (10, 2, 10, 8), (5, 5, 10, 10), (30, 0, 0, 0), (0, 15, 0, 0), (4, 9, 60, 17),
        (1, 0, 0, 0), (2, 3, 85, 0),
    ]
    out = []
    for first_only, second_only, both_passed, both_failed in tables:
        a, b = paired_arrays(first_only, second_only, both_passed, both_failed)
        for confidence in (0.95, 0.99):
            low, high = bonett_price_paired_ci(a, b, 1 - confidence)
            out.append({
                "firstOnly": first_only, "secondOnly": second_only, "bothPassed": both_passed, "bothFailed": both_failed,
                "confidence": confidence, "low": low, "high": high,
            })
        out[-1]["midP"] = _mcnemar_midp_p(a, b)
    # Sidak: evalstats widens each pair's own interval to alpha_adj = 1 - (1 - alpha)^(1/k)
    # (core/paired.py _sidak_simultaneous_cis); reproduced here for k = 3 at a 95% family level.
    a, b = paired_arrays(4, 9, 60, 17)
    alpha_adj = 1.0 - (1.0 - 0.05) ** (1.0 / 3)
    low, high = bonett_price_paired_ci(a, b, alpha_adj)
    out.append({"firstOnly": 4, "secondOnly": 9, "bothPassed": 60, "bothFailed": 17, "sidakComparisons": 3, "familyConfidence": 0.95, "confidence": 1 - alpha_adj, "low": low, "high": high})
    return out


def mid_p_cases():
    out = []
    for first_only, second_only in [(0, 0), (1, 7), (0, 5), (5, 5), (3, 12), (10, 2), (0, 1), (1, 0), (0, 40), (17, 23), (2, 60)]:
        a, b = paired_arrays(first_only, second_only, 3, 4)
        out.append({"firstOnly": first_only, "secondOnly": second_only, "midP": _mcnemar_midp_p(a, b)})
    return out


def cluster_cases():
    out = []
    shapes = [(15, 3, 0.0), (30, 5, 0.0), (30, 5, -0.1), (90, 5, 0.05), (90, 5, -0.2), (20, 1, 0.1)]
    for n, repeats, shift in shapes:
        base = RNG.uniform(0.3, 0.95, size=n)
        a = (RNG.uniform(size=(n, repeats)) < base[:, None]).astype(float)
        b = (RNG.uniform(size=(n, repeats)) < np.clip(base - shift, 0, 1)[:, None]).astype(float)
        low, high = bonett_price_paired_ci_multirun_cluster(a, b, 0.05)
        p = _p_value_by_inversion(lambda alpha, _a=a, _b=b: bonett_price_paired_ci_multirun_cluster(_a, _b, alpha))
        out.append({"first": a.astype(int).tolist(), "second": b.astype(int).tolist(), "confidence": 0.95, "low": low, "high": high, "pValue": p})
    identical = np.ones((30, 5))
    low, high = bonett_price_paired_ci_multirun_cluster(identical, identical, 0.05)
    p = _p_value_by_inversion(lambda alpha: bonett_price_paired_ci_multirun_cluster(identical, identical, alpha))
    out.append({"first": identical.astype(int).tolist(), "second": identical.astype(int).tolist(), "confidence": 0.95, "low": low, "high": high, "pValue": p})
    return out


def shaffer_cases():
    out = []
    for groups, p_values in [
        (3, [0.01, 0.04, 0.03]), (3, [0.2, 0.001, 0.5]), (3, [0.02, 0.02, 0.02]), (3, [0.9, 0.95, 1.0]),
        (4, [0.001, 0.01, 0.02, 0.03, 0.04, 0.2]), (2, [0.03]),
    ]:
        out.append({"groups": groups, "pValues": p_values, "adjusted": _shaffer_adjusted_pvalues(np.array(p_values), groups).tolist()})
    return out


def icc_one_way(rows):
    # Independent textbook one-way ANOVA ICC(1) for groups of any size (not an evalstats method), with the
    # adjusted group size k0 = (N - sum n_i^2 / N) / (g - 1). Rows are lists of 0/1 run outcomes.
    rows = [np.asarray(row, dtype=float) for row in rows]
    sizes = np.array([len(row) for row in rows], dtype=float)
    groups, total = len(rows), sizes.sum()
    grand = np.concatenate(rows).mean()
    msb = sum(len(row) * (row.mean() - grand) ** 2 for row in rows) / (groups - 1)
    msw = sum(((row - row.mean()) ** 2).sum() for row in rows) / (total - groups)
    k0 = (total - (sizes ** 2).sum() / total) / (groups - 1)
    icc = (msb - msw) / (msb + (k0 - 1) * msw)
    return {"icc": float(icc), "designEffect": float(1 + (k0 - 1) * icc), "repeatsPerCase": float(k0)}


def reliability_cases():
    out = []
    for n, repeats, spread in [(4, 2, 0.0), (30, 5, 0.9), (30, 5, 0.3), (90, 5, 0.6), (15, 3, 0.1)]:
        base = np.clip(0.6 + spread * (RNG.uniform(size=n) - 0.5) * 2, 0, 1)
        matrix = (RNG.uniform(size=(n, repeats)) < base[:, None]).astype(int)
        if matrix.std() == 0:
            continue  # ICC is undefined without variance; the TypeScript side returns null, tested separately.
        passes = matrix.sum(axis=1).tolist()
        pass_power = {str(k): float(np.mean([math.comb(c, k) / math.comb(repeats, k) for c in passes])) for k in range(1, repeats + 1)}
        pass_at = {str(k): float(np.mean([1 - math.comb(repeats - c, k) / math.comb(repeats, k) for c in passes])) for k in range(1, repeats + 1)}
        out.append({"passes": passes, "trials": repeats, **icc_one_way(matrix.tolist()), "passPowerK": pass_power, "passAtK": pass_at})
    # Unequal repeats per case (missing cells), so the k0 adjustment is checked against an independent value.
    sizes = RNG.integers(2, 6, size=40)
    rows = [(RNG.uniform(size=size) < p).astype(int).tolist() for size, p in zip(sizes, RNG.uniform(0.2, 0.95, size=40))]
    out.append({"passes": [int(sum(row)) for row in rows], "trials": [len(row) for row in rows], **icc_one_way(rows), "passPowerK": {}, "passAtK": {}})
    return out


def main():
    fixtures = {
        "generator": "tests/stats/reference/evalstats_reference.py",
        "scriptSha256": hashlib.sha256(SCRIPT.read_bytes().replace(b"\r\n", b"\n")).hexdigest(),
        "evalstatsVersion": evalstats.__version__,
        "numpyVersion": np.__version__,
        "scipyVersion": scipy.__version__,
        "pythonVersion": platform.python_version(),
        "seed": 20261024,
        "wilson": wilson_cases(),
        "wilsonOnCaseRates": wilson_rate_cases(),
        "bonettPrice": bonett_price_cases(),
        "mcnemarMidP": mid_p_cases(),
        "bonettPriceCluster": cluster_cases(),
        "shaffer": shaffer_cases(),
        "reliability": reliability_cases(),
    }
    OUTPUT.write_text(json.dumps(fixtures, indent=1) + "\n", encoding="utf-8")
    sys.stdout.write(f"Wrote {OUTPUT} with evalstats {evalstats.__version__}\n")


if __name__ == "__main__":
    main()
