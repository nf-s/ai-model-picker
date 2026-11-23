"""Import Epoch AI's own benchmark runs into research/epoch-runs.json.

Downloads Epoch's benchmark data ZIP (no key) into a new, empty folder under
.local/imports/epoch/ and reads it without extracting: the archive is untrusted data. Only
the files of Epoch's own runs listed in FILES are read; the `_external` files keep their
sources' licences and are not imported. The README must still give the CC BY 4.0 licence and
the citation in CITATION. A 'Model version' is '<base>_<reasoning setting>'; the base is kept
only when it is an exact key in research/aliases/epoch.json. Unmatched names are printed and
left out. The output has an empty `checkedAt` until a person has reviewed it
(docs/updating.md).

Usage: python3 -B scripts/import_epoch.py [--from DOWNLOAD_DIR] [--out FILE] [--aliases FILE]
"""

import argparse
import csv
import io
import json
import re
import sys
import zipfile
from pathlib import Path

from import_common import (
    ROOT, SourceError, downloaded_on, fetch, is_date, long_date, mark_downloaded, model_ids, need,
    new_download_dir, read_aliases, report, write_reviewed,
)

ZIP_URL = 'https://epoch.ai/data/benchmark_data.zip'
ZIP_NAME = 'benchmark_data.zip'
DATA_PAGE = 'https://epoch.ai/benchmarks/use-this-data'
LICENCE_LINK = 'https://creativecommons.org/licenses/by/4.0/'
CITATION = (
    'Epoch AI, ‘Capabilities & benchmarking’. Published online at epoch.ai. '
    'Retrieved from ‘https://epoch.ai/benchmarks’ [online resource].'
)
MAX_MEMBER_BYTES = 20_000_000
OUT = ROOT / 'research/epoch-runs.json'
ALIASES = ROOT / 'research/aliases/epoch.json'

RUN = " Epoch's own run."
# file, name, what it measures, page. The order is the order of the output.
FILES = (
    ('otis_mock_aime_2024_2025', 'OTIS Mock AIME 2024-2025 (Epoch run)',
     'Share of competition maths problems (OTIS mock AIME 2024–2025) answered correctly.' + RUN,
     'https://epoch.ai/benchmarks/otis-mock-aime-2024-2025'),
    ('gpqa_diamond', 'GPQA Diamond (Epoch run)',
     'Share of graduate-level science multiple-choice questions answered correctly.' + RUN,
     'https://epoch.ai/benchmarks/gpqa-diamond'),
    ('frontiermath_tiers_1_3_v2', 'FrontierMath Tiers 1-3 v2',
     'Share of research-level maths problems solved (tiers 1–3).' + RUN,
     'https://epoch.ai/benchmarks/frontiermath-tiers-1-3-v2'),
    ('frontiermath_tier_4_v2', 'FrontierMath Tier 4 v2',
     'Share of the hardest research-level maths problems solved (tier 4).' + RUN,
     'https://epoch.ai/benchmarks/frontiermath-tier-4-v2'),
    ('chess_puzzles', 'Chess Puzzles (Epoch run)',
     'Share of chess puzzles solved.' + RUN,
     'https://epoch.ai/benchmarks/chess-puzzles'),
    ('simpleqa_verified', 'SimpleQA Verified (Epoch run)',
     'Share of short factual questions answered correctly without search; not helpfulness or conversation.' + RUN,
     'https://epoch.ai/benchmarks/simple-qa-verified'),
    ('furniture_assembly', 'Furniture Assembly (Epoch run)',
     'Share correct on checking photos of furniture builds (is it right, which step is wrong); '
     'not image generation, OCR or charts.' + RUN,
     'https://epoch.ai/benchmarks/furniture-assembly'),
    ('mirrorcode', 'MirrorCode (Epoch run)',
     'Share of whole programs reimplemented from a specification without the source.' + RUN,
     'https://epoch.ai/benchmarks/mirrorcode'),
)
COLUMNS = {'Model version', 'mean_score', 'Best score (across scorers)', 'stderr', 'Log viewer', 'Started at', 'id'}
# Suffixes of 'Model version' that name a reasoning setting. Others, such as a token budget, stay in the name.
SETTINGS = {'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'promax', 'proxhigh', 'prounknown', 'unknown'}
NOT_STATED = {'unknown'}
NO_SPACE = re.compile(r'\S+')
LOG_URL = re.compile(r'https://[^\s/?#]+\S*')


def split_version(version):
    """(base, reasoning setting) of an Epoch 'Model version'."""
    base, _, setting = version.rpartition('_')
    if base and setting in SETTINGS:
        return base, setting
    return version, ''


def percent(value, digits):
    return round(float(value) * 100, digits)


def score(text, where):
    try:
        value = float(text)
    except ValueError:
        raise SourceError(f'{where}: {text!r} is not a number') from None
    need(0 <= value <= 1, f'{where}: {value} is not a share between 0 and 1')
    return value


# ---- Download ------------------------------------------------------------------------


def download(folder, get=fetch):
    (folder / ZIP_NAME).write_bytes(get(ZIP_URL))
    mark_downloaded(folder)


def member(archive, name):
    """The text of one archive member, without extracting anything."""
    need(name in archive.namelist(), f'{name} is not in the archive')
    info = archive.getinfo(name)
    need(info.file_size <= MAX_MEMBER_BYTES, f'{name}: {info.file_size:,} bytes is more than expected')
    return archive.read(info).decode('utf-8-sig')


def check_terms(readme):
    need(LICENCE_LINK in readme, 'the README no longer gives the CC BY 4.0 licence: stop and report')
    need(CITATION in readme, 'the README citation has changed: stop and report')


# ---- Validation and matching -----------------------------------------------------------


def runs(text, file):
    """The rows of one run file, checked."""
    reader = csv.DictReader(io.StringIO(text))
    need(reader.fieldnames is not None and COLUMNS <= set(reader.fieldnames),
         f'{file}: columns missing: {", ".join(sorted(COLUMNS - set(reader.fieldnames or ())))}')
    rows = list(reader)
    need(rows, f'{file}: no rows')
    seen = set()
    for row in rows:
        need(None not in row and None not in row.values(), f'{file}: a row has more or fewer cells than the header')
        version = row['Model version']
        need(NO_SPACE.fullmatch(version or ''), f'{file}: a row has no model version or one with spaces')
        need(version not in seen, f'{file}: {version} is listed twice')
        seen.add(version)
        where = f'{file} {version}'
        score(row['Best score (across scorers)'], where)
        score(row['mean_score'], where)
        if row['stderr']:
            score(row['stderr'], where)
        need(row['Started at'] == '' or is_date(row['Started at'][:10]), f'{where}: Started at is not a date')
        need(row['Log viewer'] == '' or LOG_URL.fullmatch(row['Log viewer']), f'{where}: the log link is not https')
        need(NO_SPACE.fullmatch(row['id'] or ''), f'{where}: no run id')
    return rows


def result(row, file, model_id, setting):
    return {
        'file': file,
        'model': row['Model version'],
        'modelId': model_id,
        'effort': '' if setting in NOT_STATED else setting,
        'score': percent(row['Best score (across scorers)'], 1),
        'mean': percent(row['mean_score'], 1),
        'stderr': percent(row['stderr'], 3) if row['stderr'] else None,
        'date': row['Started at'][:10],
        'log': row['Log viewer'],
        'run': row['id'],
    }


def convert(folder, aliases):
    """(reviewed file, counts per file, unmatched names) from a finished download."""
    fetched = downloaded_on(folder)
    with zipfile.ZipFile(folder / ZIP_NAME) as archive:
        check_terms(member(archive, 'README.md'))
        names = set(archive.namelist())
        files, results, counts, unmatched = [], [], {}, set()
        for file, name, what, page in FILES:
            need(f'{file}.csv' in names, f'{file}.csv is not in the archive')
            rows = runs(member(archive, f'{file}.csv'), file)
            kept = []
            for row in sorted(rows, key=lambda r: r['Model version']):
                base, setting = split_version(row['Model version'])
                model_id = aliases.get(base)
                if model_id is None:
                    unmatched.add(base)
                else:
                    kept.append(result(row, file, model_id, setting))
            files.append({
                'id': f'epoch-{file}',
                'file': file,
                'name': name,
                'what': what,
                'unit': '%',
                'scale': 'percent',
                'url': page,
                'rows': len(rows),
                'kept': len(kept),
            })
            results += kept
            counts[file] = (len(rows), len(kept))
    return {
        'source': {
            'name': 'Epoch AI benchmarking hub',
            'url': DATA_PAGE,
            'download': ZIP_URL,
            'licence': 'CC BY 4.0',
            'licenceUrl': LICENCE_LINK,
            'attribution': f'{CITATION} Accessed {long_date(fetched)}. Licensed under CC BY 4.0.',
        },
        'fetchedAt': fetched,
        'checkedAt': '',
        'files': files,
        'results': results,
    }, counts, unmatched


def main(argv=None):
    parser = argparse.ArgumentParser(description="Import Epoch AI's own benchmark runs into research/epoch-runs.json.")
    parser.add_argument('--from', dest='source', type=Path, help='read an earlier download instead of fetching')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--aliases', type=Path, default=ALIASES)
    args = parser.parse_args(argv)
    try:
        aliases = read_aliases(args.aliases, model_ids())
        folder = args.source
        if folder is None:
            folder = new_download_dir('epoch')
            print(f'Downloading into {folder}')
            download(folder)
        data, counts, unmatched = convert(folder, aliases)
        write_reviewed(args.out, data)
    except (SourceError, OSError, zipfile.BadZipFile, UnicodeDecodeError, csv.Error) as error:
        raise SystemExit(f'Epoch import stopped: {error}') from None
    report(counts, unmatched, args.out)


if __name__ == '__main__':
    sys.exit(main())
