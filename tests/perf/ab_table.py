import json, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'tests/perf/results/frontend_ab.json'
d = json.load(open(path, encoding='utf-8'))
L = d['experiments']['load']

hdr = '{:16}{:14}{:>8}{:>9}{:>9}{:>8}  {}'.format('variant', 'metric', 'min', 'med', 'max', 'sd', 'samples')
print(hdr)
print('-' * 118)
for v in L:
    for k in ['fcp', 'dcl', 'recordsReady', 'chartsReady', 'staticDecoded', 'longestTask', 'wall']:
        s = L[v]['summary'].get(k)
        if not s or not s['n']:
            continue
        vals = [round(x) for x in s['samples']]
        print('{:16}{:14}{:>8}{:>9}{:>9}{:>8.1f}  {}'.format(
            v, k, round(s['min']), round(s['median']), round(s['max']), s['sd'], vals))
    print('-' * 118)

base = L['baseline']['summary']
print('')
print('deltas vs baseline (median):')
for v in L:
    if v == 'baseline':
        continue
    out = []
    for k in ['fcp', 'dcl', 'recordsReady', 'staticDecoded', 'longestTask']:
        b = base.get(k, {}).get('median')
        c = L[v]['summary'].get(k, {}).get('median')
        if b is None or c is None:
            continue
        out.append('{}: {:+.0f} ({:+.0f}%)'.format(k, c - b, (c - b) / b * 100))
    print('  {:16} {}'.format(v, '  '.join(out)))
