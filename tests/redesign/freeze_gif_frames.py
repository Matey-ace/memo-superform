"""Test-only original GIF frame-0 extraction and raw screenshot pixel comparison."""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OWN = ROOT / 'docs/redesign/deterministic-prep'
SOURCE = ROOT / 'docs/redesign/source-before/assets-sha256.json'

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def owned(p):
    p = Path(p).resolve()
    if not p.is_relative_to(OWN.resolve()):
        raise ValueError('Output must stay under docs/redesign/deterministic-prep')
    return p

def save_new(p, value):
    with p.open('x', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)

def extract(out):
    out = owned(out)
    out.mkdir(parents=True, exist_ok=False)
    assets = json.loads(SOURCE.read_text(encoding='utf-8'))['files']
    allow = {k: v for k, v in assets.items() if k.startswith('img/gifs/') and k.endswith('.gif')}
    if not allow or set(allow) != {k for k in assets if k.endswith('.gif')}:
        raise ValueError('Unexpected public GIF allowlist')
    entries = []
    for relative, expected in sorted(allow.items()):
        assert relative.startswith('img/') and '..' not in Path(relative).parts, relative
        original = (ROOT / relative).resolve()
        assert original.is_relative_to((ROOT / 'img').resolve())
        before = digest(original)
        assert before == expected, 'Original differs from source-before: ' + relative
        with Image.open(original) as image:
            size = image.size
            image.seek(0)
            frame = image.convert('RGBA')
            assert frame.size == size
            target = out / (relative.replace('/', '__') + '.frame0.png')
            frame.save(target, format='PNG')
        assert digest(original) == before
        entries.append(dict(path=relative, url_path='/' + relative, original_sha256=before,
                            expected_sha256=expected, original_bytes=original.stat().st_size,
                            original_size=list(size), frame_index=0, frame_png=target.name,
                            frame_png_sha256=digest(target), frame_png_size=list(frame.size)))
    report = dict(testOnly=True, mode='test-only deterministic original frame 0', realCanvasProven=False,
                  source_manifest=str(SOURCE), source_manifest_sha256=digest(SOURCE), entries=entries,
                  allowlist=[x['url_path'] for x in entries], no_data_traversal=True,
                  prewrite_review='Read round1-audit.js, baseline-matrix.js and existing preparation scripts; existing outputs preserved.')
    save_new(out / 'frames.json', report)
    print('Extracted', len(entries), 'allowlisted original GIF frame-0 PNGs')

def compare(first, second, out):
    out = owned(out)
    with Image.open(first) as a, Image.open(second) as b:
        a, b = a.convert('RGB'), b.convert('RGB')
        if a.size != b.size:
            value = dict(equal=False, first_size=a.size, second_size=b.size, error='size mismatch')
        else:
            import numpy as np
            aa, bb = np.asarray(a), np.asarray(b)
            changed = np.any(aa != bb, axis=2)
            count = int(changed.sum())
            ys, xs = np.where(changed)
            bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if count else None
            value = dict(equal=count == 0, changed_pixels=count, total_pixels=int(changed.size),
                         fraction=count / changed.size, bbox=bbox,
                         max_channel_delta=int(np.abs(aa.astype('int16') - bb.astype('int16')).max()),
                         first_sha256=digest(Path(first)), second_sha256=digest(Path(second)),
                         image_size=list(a.size), comparison='strict RGB any channel difference, no threshold/mask/crop/postprocessing')
    save_new(out, value)
    print(json.dumps(value))

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    ext = sub.add_parser('extract')
    ext.add_argument('--out', required=True)
    cmp = sub.add_parser('compare')
    cmp.add_argument('--first', required=True)
    cmp.add_argument('--second', required=True)
    cmp.add_argument('--out', required=True)
    args = parser.parse_args()
    if args.command == 'extract':
        extract(args.out)
    else:
        compare(args.first, args.second, args.out)

if __name__ == '__main__':
    main()
