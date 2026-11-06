import subprocess, json, sys, os

# Configure via environment variables (no machine-specific paths):
#   STUDY_REPO       path to the git repo under study (a clone you provide)
#   DRIFTGUARD_CLI   path to the built CLI (run `npm run build` in ../driftguard-fixed first)
#   COMMITS_FILE     TSV of "<index>\t<commit-hash>" lines, oldest to newest
#   PILOT_OUT        where to write raw results JSON
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("STUDY_REPO", "")
CLI = os.environ.get("DRIFTGUARD_CLI", os.path.join(HERE, "..", "driftguard-fixed", "dist", "cli.js"))
COMMITS_FILE = os.environ.get("COMMITS_FILE", "contract_commits_ordered.txt")
OUT = os.environ.get("PILOT_OUT", "pilot_raw.json")
if not REPO or not os.path.isdir(REPO):
    sys.exit("Set STUDY_REPO to a local clone of the repository under study.")
if not os.path.isfile(COMMITS_FILE):
    sys.exit(f"COMMITS_FILE not found: {COMMITS_FILE}. Provide a TSV of '<index>\\t<commit-hash>' lines, oldest to newest.")
if not os.path.isfile(CLI):
    sys.exit(f"DriftGuard CLI not found: {CLI}. Run `npm run build` in ../driftguard-fixed or set DRIFTGUARD_CLI.")

def sh(args, cwd=REPO, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode not in (0,1):
        print("FAILED:", args, "rc=", r.returncode, r.stderr[:500], file=sys.stderr)
    return r

candidates = []
for line in open(COMMITS_FILE):
    idx, h = line.strip().split("\t")
    candidates.append((int(idx), h))

# Remember where the clone was so we can put it back afterwards.
_head = subprocess.run(["git","symbolic-ref","--short","-q","HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
if not _head:
    _head = subprocess.run(["git","rev-parse","HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()

results = []
for idx, h in candidates:
    parent = sh(["git","rev-parse", h+"^"]).stdout.strip()
    if not parent:
        continue
    co = sh(["git","checkout","--quiet","--detach", h])
    if co.returncode != 0:
        print("checkout failed", h, co.stderr[:200], file=sys.stderr)
        continue
    run = sh(["node", CLI, "check", "--client", "frontend/src", "--server", "backend/app",
              "--base", parent, "--format", "json"])
    out = run.stdout.strip()
    try:
        data = json.loads(out) if out else None
    except json.JSONDecodeError:
        data = None
    results.append({
        "idx": idx, "commit": h, "parent": parent,
        "stdout_len": len(out), "stderr": run.stderr[:300],
        "rc": run.returncode, "data": data,
    })
    print(f"{idx}\t{h[:10]}\trc={run.returncode}\tchanges={ (data or {}).get('summary',{}).get('totalChanges') if data else 'PARSE_FAIL'}", file=sys.stderr)

sh(["git","checkout","--quiet",_head])
json.dump(results, open(OUT,"w"))
print("done, wrote", len(results), "results", file=sys.stderr)
