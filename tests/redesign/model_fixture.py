"""Read-only public-model fixture; never imports or copies daily databases."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
ISOLATED = (ROOT / '_verification/redesign/data-main').resolve()
SOURCE = ROOT / 'data/live2d/models/bestdori-037_birthday_2024_ssr-fb4e0843b7ac'
OUT = ROOT / 'docs/redesign/baseline/real-model'
TARGET = ISOLATED / 'live2d/models' / SOURCE.name

def hashes(root):
    result = {}
    for p in sorted(root.rglob('*')):
        assert not p.is_symlink(), str(p)
        if p.is_file():
            result[p.relative_to(root).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result

def main():
    assert ISOLATED != (ROOT / 'data').resolve()
    assert ISOLATED == (ROOT / '_verification/redesign/data-main').resolve()
    os.environ['MEMO_DATA_DIR'] = str(ISOLATED)
    sys.path.insert(0, str(ROOT))
    OUT.mkdir(parents=True, exist_ok=True)
    before = hashes(SOURCE)
    (OUT / 'source-before.sha256.json').write_text(json.dumps(before, indent=2), encoding='utf-8')
    manifest = json.loads((SOURCE / 'memo-live2d.json').read_text(encoding='utf-8'))
    if TARGET.exists():
        assert hashes(TARGET) == before, 'Existing target differs; refusing overwrite'
        action = 'reused-identical'
    else:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(SOURCE, TARGET)
        action = 'copied'
    assert hashes(TARGET) == before
    import db
    db_path = Path(db.database_path()).resolve()
    assert db_path.is_relative_to(ISOLATED)
    assert Path(db._DB_PATH).resolve() == db_path
    db.init_db(str(ISOLATED))
    metadata = dict(model_id=manifest['id'], source='bestdori', character_id='037',
                    display_name='Chihaya Anon', catalog_name='037_birthday_2024_ssr',
                    model_format=manifest['format'], relative_path=SOURCE.name,
                    entry_file=manifest['entry'], manifest=manifest,
                    byte_size=sum(p.stat().st_size for p in TARGET.rglob('*') if p.is_file()), complete=True)
    db.upsert_live2d_model(metadata)
    pref = db.set_live2d_preference(None, active_model_id=manifest['id'], companion_enabled=True)
    after = hashes(SOURCE)
    (OUT / 'source-after.sha256.json').write_text(json.dumps(after, indent=2), encoding='utf-8')
    assert before == after == hashes(TARGET)
    result = dict(timestamp=datetime.now(timezone.utc).isoformat(), source=str(SOURCE), target=str(TARGET),
                  isolated_root=str(ISOLATED), db_path=str(db_path), action=action, file_count=len(before),
                  source_hashes_unchanged=True, target_hashes_equal=True, registration=metadata, preference=pref,
                  character_id_provenance='037 from original bestdori catalog directory name; manifest has no character_id',
                  role_package_created=False, voice_copied=False,
                  prewrite_review='git status --short and git diff --stat reviewed; git diff -- db.py live2d_service.py app_api.py reviewed. Existing changes preserved.',
                  scope_incident='A root glob for *paths*.py unexpectedly enumerated path metadata under data/tts_pack and other trees. No returned voice file content was read. Therefore no claim of zero forbidden-scope traversal or zero-difference proof is made.')
    (OUT / 'fixture.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(dict(file_count=len(before), action=action, db_path=str(db_path), hashes_equal=True)))

if __name__ == '__main__':
    main()
