# Generates the reference constants pasted into tests/stats/*.test.ts.
# Run once with: uv run --with scipy python tests/stats/reference/scipy_reference.py
# Not part of the test suite; kept so the constants can be re-derived independently of the TypeScript code.
from scipy import stats
from scipy.stats import beta, binom, norm, binomtest
from scipy.optimize import brentq
import math
def wilson(k,n,c=0.95):
    r=binomtest(k,n).proportion_ci(confidence_level=c,method='wilson'); return (r.low,r.high)
def cp(k,n,c=0.95):
    r=binomtest(k,n).proportion_ci(confidence_level=c,method='exact'); return (r.low,r.high)
def cp_upper(k,n,c=0.95): return 1.0 if k==n else beta.ppf(c,k+1,n-k)
def cp_lower(k,n,c=0.95): return 0.0 if k==0 else beta.ppf(1-c,k,n-k+1)
def wilson_upper(k,n,c=0.95):
    z=norm.ppf(c);p=k/n;return (p+z*z/(2*n)+z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n)
def wilson_lower(k,n,c=0.95):
    z=norm.ppf(c);p=k/n;return (p+z*z/(2*n)-z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n)
for q in [0.5,0.9,0.95,0.975,0.99,0.999,0.0001]: print("z",q,repr(norm.ppf(q)))
for k,n in [(27,30),(0,30),(30,30),(1,1),(0,1),(15,30),(3,300)]:
    print("wilson",k,n,[repr(x) for x in wilson(k,n)]); print("cp",k,n,[repr(x) for x in cp(k,n)])
print("wilson99 27/30",[repr(x) for x in wilson(27,30,0.99)]); print("cp90 27/30",[repr(x) for x in cp(27,30,0.90)])
for k,n in [(0,300),(0,30),(2,30),(30,30),(0,1),(1,1)]:
    print("cp_upper",k,n,repr(cp_upper(k,n)),"cp_lower",repr(cp_lower(k,n)),"w_upper",repr(wilson_upper(k,n)),"w_lower",repr(wilson_lower(k,n)))
for k,n,p in [(3,10,0.5),(0,30,0.1),(27,30,0.9),(30,30,0.9),(5,300,0.01)]: print("cdf",k,n,p,repr(binom.cdf(k,n,p)))
for b,c in [(1,7),(0,5),(5,5),(0,0),(3,12),(10,2),(0,1)]:
    n=b+c; p=1.0 if n==0 else binomtest(min(b,c),n,0.5).pvalue; print("mcnemar",b,c,repr(p))
def n_paired(delta,psi,alpha=0.05,power=0.8):
    za=norm.ppf(1-alpha/2);zb=norm.ppf(power);return (za*math.sqrt(psi)+zb*math.sqrt(psi-delta*delta))**2/delta**2
for d,psi in [(0.1,0.2),(0.2,0.3),(0.05,0.1)]: print("n_paired",d,psi,repr(n_paired(d,psi)))
for n,psi in [(30,0.2),(30,0.5),(300,0.2),(30,0.1),(100,0.1),(30,0.3),(30,1.0)]:
    if n_paired(psi,psi) > n: print("mde",n,psi,None,"n at max",repr(n_paired(psi,psi))); continue
    print("mde",n,psi,repr(float(brentq(lambda d:n_paired(d,psi)-n,1e-9,psi))))
