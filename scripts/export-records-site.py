"""Copy core.json from the records build into dist/ for the published app.

It carries measured records, Hacker News counts and OpenRouter usage only. Named records stay in
named-private.json, which is never copied; the copy stops if core.json holds a named record."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIELDS = {'sources', 'jobs', 'models', 'lines', 'benchmarks', 'measured', 'crowd', 'preferences', 'coverage',
          'usage', 'namedBehindSignIn'}


def export_core(source, output):
    core = json.loads(Path(source).read_text(encoding='utf-8'))
    if not isinstance(core, dict) or set(core) != FIELDS:
        raise ValueError('core.json does not have the fields the app reads.')
    if any(record.get('cls') != 'measured' or record.get('quote') for record in core['measured']):
        raise ValueError('core.json holds a record that is not measured.')
    Path(output).write_text(json.dumps(core, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    return core


if __name__ == '__main__':
    try:
        core = export_core(ROOT / 'build/records/core.json', ROOT / 'dist/core.json')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        sys.exit('Could not export build/records/core.json. Run npm run records:build first; see docs/updating.md.')
    print(f'Exported core.json: {len(core["measured"]):,} measured records, {core["sources"]["hn"]["comments"]:,} '
          'Hacker News comments.')
