import json, statistics, sys

p = sys.argv[1]
d = json.load(open(p, encoding='utf-8'))

def fmt(x, n=2):
    return ("%." + str(n) + "f") % x

print("=== META ===")
for k in ("generatedAt", "url", "rounds", "sampleMs", "settleMs", "browserRootPid", "rendererReadyMs"):
    print(" ", k, "=", d["meta"].get(k))

print("\n=== PER-ROUND RAW (state | cpu% | wsMB | privMB | gpu3d | rafFps | hidden | tickerDelta) ===")
for r in d["rounds"]:
    for s in r["samples"]:
        pg = s["page"]
        print("r%d %-10s cpu=%7s ws=%7s priv=%7s gpu3d=%5s raf=%7s hidden=%-5s d=%6s procs=%d" % (
            r["round"], s["state"],
            fmt(s["cpuMachinePercent"], 4), fmt(s["workingSetMB"], 1), fmt(s["privateMB"], 1),
            fmt(s["gpu3dSum"], 0), fmt(pg["rafFps"] or 0, 2), s["effectiveState"]["hidden"],
            pg["tickerDeltaMS"], s["processCount"]))

print("\n=== SUMMARY ===")
for st, v in d["states"].items():
    print("\n--", st, "n=%d" % v["n"], "tickerStartedAlways=", v["tickerStartedAlways"])
    print("   hidden flags:", v["hiddenFlags"])
    for key in ("cpuMachinePercent", "workingSetMB", "privateMB", "gpu3dSum", "gpuUtilSum", "rafFps", "tickerDeltaMS", "medianFrameGapMs"):
        s = v[key]
        print("   %-18s median=%8s min=%8s max=%8s" % (
            key, fmt(s["median"] or 0, 3), fmt(s["min"] or 0, 3), fmt(s["max"] or 0, 3)))
        print("        all:", s["all"])

print("\n=== COLD ===")
for c in d["coldStarts"]:
    print(" cold%d readyMs=%s ws=%sMB priv=%sMB cpuSec=%s procs=%s" % (
        c["coldRound"], c["loadToRendererReadyMs"], c["workingSetMB"], c["privateMB"],
        c["cpuSecondsAtReady"], c["processCount"]))
cs = d["coldSummary"]
for k in ("loadToRendererReadyMs", "workingSetMB", "privateMB", "cpuSecondsAtReady"):
    print("  %-24s median=%s min=%s max=%s" % (k, cs[k]["median"], cs[k]["min"], cs[k]["max"]))
