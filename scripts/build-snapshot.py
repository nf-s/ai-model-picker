"""Normalize reviewed source snapshots; never fetch data or match model versions fuzzily."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(name):
    return json.loads((ROOT / 'research' / f'{name}.json').read_text())

def slug(value):
    return re.sub(r'[^a-z0-9]+', '-', value.lower()).strip('-')

def rates(value):
    out = {'input': value['inputUsdPerMillion'], 'output': value['outputUsdPerMillion']}
    if 'cachedInputUsdPerMillion' in value:
        out['cachedInput'] = value['cachedInputUsdPerMillion']
    return out

pricing = read('pricing')
benchmark_inputs = [read('benchmarks'), read('creative-benchmarks')]
report_input = read('reports')
# Results whose source terms do not allow republishing stay in an ignored local
# file and are written to a separate local output, never to the tracked snapshot.
restricted_ids = {item['id'] for item in json.loads((ROOT / 'src' / 'lib' / 'restricted-benchmarks.json').read_text())['benchmarks']}
restricted_input = ROOT / '.local' / 'restricted' / 'research.json'
if not restricted_input.exists():
    raise SystemExit(f'Missing {restricted_input.relative_to(ROOT)}: the restricted benchmark results are kept outside Git.')
restricted_rows = json.loads(restricted_input.read_text())
if set(restricted_rows) != restricted_ids:
    raise SystemExit('The local restricted results do not match src/lib/restricted-benchmarks.json.')
model_records = []
name_to_id = {}
for item in pricing['models']:
    price = {**rates(item), 'url': item['priceUrl'], 'modelUrl': item['modelUrl'], 'notes': item['pricingNotes'], 'contextType': item.get('contextType', 'unified')}
    if 'contextTokens' in item:
        price['contextTokens'] = item['contextTokens']
    if 'longContextPricing' in item:
        tier = item['longContextPricing']
        price['longContext'] = {**rates(tier), 'thresholdTokens': tier['thresholdTokens'], 'inclusive': tier['thresholdOperator'] == '>='}
    if 'nextPricing' in item:
        price['nextPricing'] = {**rates(item['nextPricing']), 'effectiveFrom': item['nextPricing']['effectiveFrom']}
    if 'offPeakPricing' in item:
        price['offPeak'] = rates(item['offPeakPricing'])
    model = {'id': item['id'], 'name': item['name'], 'provider': item['provider'], 'apiId': item['apiId'], 'description': item['description'], 'pricing': price, 'status': item.get('status', 'current')}
    if item.get('version'):
        model['version'] = item['version']
    model_records.append(model)
    name_to_id[item['name']] = item['id']

# Explicit spelling aliases only. Dated model versions are never stripped generically.
aliases = {
    'DeepSeek V4.1 Flash 1017': 'DeepSeek V4.1 Flash',
    'DeepSeek-V4.1-Flash-1017': 'DeepSeek V4.1 Flash',
    'DeepSeek-V4.1-Flash (1017)': 'DeepSeek V4.1 Flash',
    'DeepSeek V4 Pro 0813': 'DeepSeek V4 Pro',
    'Qwen3.8-Max-0902': 'Qwen3.8 Max (0902)',
    'MiMo V2.6 Pro': 'MiMo-V2.6-Pro',
    'Inkling Small 2': 'Inkling 2 Small',
    'Hy4': 'Tencent Hy4',
}

def provider_for(name, reported=None):
    if reported:
        return {'Google DeepMind': 'Google', 'SpaceXAI': 'xAI', 'Kimi': 'Moonshot AI', 'Z AI': 'Z.ai', 'Thinking Machines': 'Thinking Machines Lab'}.get(reported, reported)
    for prefix, provider in [('GPT-', 'OpenAI'), ('ChatGPT ', 'OpenAI'), ('Claude ', 'Anthropic'), ('Gemini ', 'Google'), ('Nano Banana', 'Google'), ('DeepSeek', 'DeepSeek'), ('Grok', 'xAI'), ('Muse ', 'Meta'), ('Kimi ', 'Moonshot AI'), ('Qwen', 'Alibaba'), ('GLM', 'Z.ai'), ('MiMo', 'Xiaomi'), ('MiniMax', 'MiniMax'), ('Mistral ', 'Mistral'), ('Inkling', 'Thinking Machines Lab'), ('Tencent', 'Tencent'), ('Nemotron', 'NVIDIA')]:
        if name.startswith(prefix):
            return provider
    return 'Not verified'

def model_id(name, reported=None):
    canonical = aliases.get(name, name)
    if canonical in name_to_id:
        return name_to_id[canonical]
    identifier = slug(canonical)
    if any(record['id'] == identifier for record in model_records):
        identifier = 'reported-' + identifier
    if any(record['id'] == identifier for record in model_records):
        raise ValueError(f'Ambiguous identifier: {canonical}')
    name_to_id[canonical] = identifier
    model_records.append({'id': identifier, 'name': canonical, 'provider': provider_for(canonical, reported)})
    return identifier

def interval_label(value):
    if isinstance(value, str):
        return value
    if 'halfWidth' in value:
        return f"±{value['halfWidth']} · {value['kind']}"
    return f"{value['lower']}–{value['upper']} · {value['kind']}"

benchmarks, results = [], []
for dataset in benchmark_inputs:
    for item in dataset['benchmarks']:
        source = 'Artificial Analysis' if item['id'].startswith('aa-') else 'Epoch AI' if item['id'].startswith('epoch-') else 'ARC Prize' if item['id'].startswith('arc-') else item['name'].split(' · ')[0]
        method = item['methodology']
        if method.startswith('http'):
            method = item['description'] + ' Methodology: ' + method
        if item.get('selectionMethod'):
            method += ' ' + item['selectionMethod']
        if item.get('attribution'):
            method += ' Attribution: ' + item['attribution']
        record = {'id': item['id'], 'name': item['name'], 'source': source, 'category': item['category'], 'unit': item['unit'], 'description': item['description'], 'methodology': method, 'url': item['url']}
        for key in ['costMethod', 'timeMethod']:
            if item.get(key):
                record[key] = item[key]
        updated = item.get('updatedAt', item.get('publishedDataUpdatedAt'))
        if updated:
            record['updatedAt'] = updated
        benchmarks.append(record)
        rows = item['results']
        if item['id'] in restricted_ids:
            if rows:
                raise SystemExit(f"{item['id']} results must stay in {restricted_input.relative_to(ROOT)}, not research/.")
            rows = restricted_rows[item['id']]
        for index, row in enumerate(rows):
            details = [row.get('details', '')]
            if row.get('sampleSize'):
                details.append(f"Sample size: {row['sampleSize']}.")
            if row.get('winRatePercent') is not None:
                details.append(f"Reported win rate: {row['winRatePercent']}%.")
            if row.get('displayedMarginPercent') is not None:
                details.append(f"Displayed margin: ±{row['displayedMarginPercent']}% (as displayed; definition unclear).")
            result = {'id': f"{item['id']}:{index + 1}", 'modelId': model_id(row['modelName'], row.get('provider')), 'benchmarkId': item['id'], 'score': row['score'], 'configuration': row['configuration'], 'details': ' '.join(part for part in details if part), 'sourceUrl': row.get('sourceUrl', item['url'])}
            for key in ['costUsd', 'timeSeconds', 'totalCostUsd', 'trials']:
                if key in row:
                    result[key] = row[key]
            if 'interval' in row:
                result['interval'] = interval_label(row['interval'])
            elif row.get('confidence'):
                result['interval'] = row['confidence']
            date = row.get('runDate', row.get('publicationDate'))
            if date:
                result['runDate'] = date
            results.append(result)

reports = []
for item in report_input['reports']:
    record = {**item, 'modelIds': [model_id(name) for name in item['modelNames']]}
    reports.append(record)

sources_by_url = {}
for dataset in [pricing, *benchmark_inputs, report_input]:
    for item in dataset['sources']:
        url = item['url'].rstrip('/')
        if url not in sources_by_url:
            sources_by_url[url] = {'id': slug(item['name']), **item}

public_results = [result for result in results if result['benchmarkId'] not in restricted_ids]
restricted_results = [result for result in results if result['benchmarkId'] in restricted_ids]
snapshot = {'checkedAt': pricing['checkedAt'], 'models': model_records, 'benchmarks': benchmarks, 'results': public_results, 'reports': reports, 'sources': list(sources_by_url.values())}
path = ROOT / 'src' / 'lib' / 'snapshot.json'
path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + '\n')
restricted_path = ROOT / '.local' / 'restricted' / 'results.json'
restricted_path.write_text(json.dumps({'results': restricted_results}, indent=2, ensure_ascii=False) + '\n')
print(f"Saved {len(model_records)} model identities, {len(benchmarks)} benchmarks, {len(public_results)} public and {len(restricted_results)} restricted results, {len(reports)} reports, {len(sources_by_url)} sources.")
