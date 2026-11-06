import subprocess, json, sys, os

# Configure via environment variables (no machine-specific paths):
#   STUDY_REPO       local clone of the FastAPI full-stack template repo
#   DRIFTGUARD_CLI   path to the built CLI (run `npm run build` in ../driftguard-fixed first)
#   SCAN_OUT         output JSON path
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("STUDY_REPO", "")
CLI = os.environ.get("DRIFTGUARD_CLI", os.path.join(HERE, "..", "driftguard-fixed", "dist", "cli.js"))
OUT = os.environ.get("SCAN_OUT", os.path.join(HERE, "fastapi_template_scan.json"))
if not REPO or not os.path.isdir(REPO):
    sys.exit("Set STUDY_REPO to a local clone of the repository under study.")

def sh(args, cwd=REPO):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)

# oldest -> newest, non-merge, touching backend/app
log = sh(["git", "log", "--no-merges", "--reverse", "--format=%H", "--", "backend/app"])
commits = log.stdout.strip().split("\n")
print(f"{len(commits)} commits to scan", file=sys.stderr)

results = []
for i, c in enumerate(commits):
    parent = sh(["git", "rev-parse", c + "^"]).stdout.strip()
    if not parent:
        continue
    co = sh(["git", "checkout", "--quiet", "--detach", c])
    if co.returncode != 0:
        print(f"[{i}] checkout failed {c}: {co.stderr[:200]}", file=sys.stderr)
        continue
    run = sh(["node", CLI, "check", "--client", "frontend/src", "--server", "backend/app",
              "--base", parent, "--format", "json"])
    out = run.stdout.strip()
    try:
        data = json.loads(out) if out else None
    except json.JSONDecodeError:
        data = None
    ts = sh(["git", "show", "-s", "--format=%cI", c]).stdout.strip()
    total = (data or {}).get("summary", {}).get("totalChanges", "PARSE_FAIL" if data is None else None)
    results.append({
        "idx": i, "commit": c, "parent": parent, "timestamp": ts,
        "rc": run.returncode, "stderr": run.stderr[:300], "data": data,
    })
    print(f"[{i}/{len(commits)}] {c[:10]}  {ts}  totalChanges={total}", file=sys.stderr)

sh(["git", "checkout", "--quiet", "main"])
json.dump(results, open(OUT, "w"))
print(f"done, wrote {len(results)} results", file=sys.stderr)
