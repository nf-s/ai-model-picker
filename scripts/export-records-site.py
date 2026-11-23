"""Copy core.json and the search index from the records build into dist/ for the published app.

It carries measured records, Hacker News counts and OpenRouter usage only. Named records stay in
named-private.json, which is never copied; the copy stops if core.json holds a named record.

The app renders Hacker News counts from core.json and loads the exported comment parts only when
someone opens the comments, so the two must describe the same collection: the copy stops when the
comment count or the collection dates differ from dist/hn-snapshot.json.

The search index (build/records/search/, see scripts/search_index.py) is copied to dist/search/. It
holds measured records and the same Hacker News labels; the copy stops when its counts differ from
core.json's or a record file holds a named record."""

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIELDS = {'sources', 'jobs', 'models', 'lines', 'benchmarks', 'measured', 'crowd', 'preferences', 'coverage',
          'usage', 'namedBehindSignIn'}


def same_collection(core, snapshot):
    """Whether core.json's Hacker News counts come from the collection in the exported snapshot."""
    hn, status = core['sources']['hn'], snapshot['status']
    return (
        hn['comments'] == status['totals'].get('commentsAboutTargets', status['totals']['candidates'])
        and hn['startAt'] == status['startAt']
        and hn['endAt'] == status['endAt']
    )


def export_core(source, output, snapshot=None):
    core = json.loads(Path(source).read_text(encoding='utf-8'))
    if not isinstance(core, dict) or set(core) != FIELDS:
        raise ValueError('core.json does not have the fields the app reads.')
    if any(record.get('cls') != 'measured' or record.get('quote') for record in core['measured']):
        raise ValueError('core.json holds a record that is not measured.')
    if snapshot is not None and not same_collection(core, json.loads(Path(snapshot).read_text(encoding='utf-8'))):
        raise ValueError('core.json and the Hacker News export describe different collections.')
    Path(output).write_text(json.dumps(core, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    return core


def export_search(source, output, core):
    """Copy the search index folder; returns (manifest, files, bytes)."""
    source, output = Path(source), Path(output)
    manifest = json.loads((source / 'index.json').read_text(encoding='utf-8'))
    crowd, measured = manifest['bands']['crowd'], manifest['bands']['measured']
    if (crowd[1] - crowd[0], measured[1] - measured[0]) != (core['sources']['hn']['comments'], len(core['measured'])):
        raise ValueError('The search index and core.json describe different records.')
    for path in sorted((source / 'r').glob('*.json')):
        if any(record.get('cls') not in ('measured', 'crowd') or 'quote' in record or 'person' in record
               for record in json.loads(path.read_text(encoding='utf-8'))['records']):
            raise ValueError('The search index holds a record that is not public.')
    if output.exists():
        raise ValueError('dist/search already exists.')
    shutil.copytree(source, output)
    files = [path for path in output.rglob('*') if path.is_file()]
    return manifest, len(files), sum(path.stat().st_size for path in files)


if __name__ == '__main__':
    try:
        core = export_core(ROOT / 'build/records/core.json', ROOT / 'dist/core.json', ROOT / 'dist/hn-snapshot.json')
        manifest, files, size = export_search(ROOT / 'build/records/search', ROOT / 'dist/search', core)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        sys.exit('Could not export build/records/core.json and build/records/search. Run npm run build:pages again; '
                 'see docs/updating.md.')
    print(f'Exported core.json: {len(core["measured"]):,} measured records, {core["sources"]["hn"]["comments"]:,} '
          'Hacker News comments.')
    print(f'Exported the search index: {manifest["records"]:,} records in {files:,} files, {size:,} bytes.')
