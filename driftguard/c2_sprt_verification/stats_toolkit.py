"""Fisher's exact test + Wilson/Clopper-Pearson intervals, per
TEST_METHODOLOGY_C1_C2.md. Validated against known reference values before
use on real data."""
from scipy import stats
import math

def fisher_exact_2x2(a, b, c, d):
    """a=untested&broke, b=untested&didnt, c=tested&broke, d=tested&didnt"""
    table = [[a, b], [c, d]]
    odds_ratio, p = stats.fisher_exact(table)
    return odds_ratio, p

def wilson_ci(successes, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = successes / n
    denom = 1 + z**2 / n
    center = (p + z*z/(2*n)) / denom
    margin = (z * math.sqrt((p*(1-p) + z*z/(4*n)) / n)) / denom
    return (max(0, center - margin), min(1, center + margin))

def clopper_pearson_ci(successes, n, alpha=0.05):
    if n == 0:
        return (float("nan"), float("nan"))
    lo = stats.beta.ppf(alpha/2, successes, n - successes + 1) if successes > 0 else 0.0
    hi = stats.beta.ppf(1 - alpha/2, successes + 1, n - successes) if successes < n else 1.0
    return (lo, hi)

if __name__ == "__main__":
    # Sanity check against a textbook Fisher's-exact reference case
    # (Fisher's tea-tasting-lady style 2x2, known p approx 0.4857)
    orr, p = fisher_exact_2x2(3,1,1,3)
    print("reference check (3,1,1,3): OR=%.4f p=%.4f (expected p~0.4857)" % (orr, p))
    print("Wilson CI 50/100:", wilson_ci(50,100))
    print("Clopper-Pearson 2/38:", clopper_pearson_ci(2,38))
