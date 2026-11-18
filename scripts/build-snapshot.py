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
# Benchmarks whose source terms do not allow republishing are kept in an ignored
# local file, with their sources, guide evidence and credits. They are written to
# a separate local payload, never to the tracked snapshot. `position` restores
# each benchmark's place so model identities keep their order.
restricted_input = ROOT / '.local' / 'restricted' / 'research.json'
if not restricted_input.exists():
    raise SystemExit(f'Missing {restricted_input.relative_to(ROOT)}: benchmarks that cannot be republished are kept outside Git.')
restricted = json.loads(restricted_input.read_text())
restricted_ids = {item['id'] for item in restricted['benchmarks']}
benchmark_items = [item for dataset in benchmark_inputs for item in dataset['benchmarks']]
if restricted_ids & {item['id'] for item in benchmark_items}:
    raise SystemExit(f'Restricted benchmarks must stay in {restricted_input.relative_to(ROOT)}, not research/.')
for item in sorted(restricted['benchmarks'], key=lambda entry: entry['position']):
    benchmark_items.insert(item['position'], item)
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
for item in benchmark_items:
    source = item.get('source') or ('Epoch AI' if item['id'].startswith('epoch-') else item['name'].split(' · ')[0])
    method = item['methodology']
    if method.startswith('http'):
        method = item['description'] + ' Methodology: ' + method
    if item.get('selectionMethod'):
        method += ' ' + item['selectionMethod']
    if item.get('attribution'):
        method += ' Attribution: ' + item['attribution']
    record = {'id': item['id'], 'name': item['name'], 'source': source, 'category': item['category'], 'unit': item['unit'], 'description': item['description'], 'methodology': method, 'url': item['url']}
    for key in ['costMethod', 'timeMethod', 'shortName']:
        if item.get(key):
            record[key] = item[key]
    updated = item.get('updatedAt', item.get('publishedDataUpdatedAt'))
    if updated:
        record['updatedAt'] = updated
    benchmarks.append(record)
    for index, row in enumerate(item['results']):
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

restricted_sources = {}
for item in restricted['sources']:
    url = item['url'].rstrip('/')
    if url not in sources_by_url and url not in restricted_sources:
        restricted_sources[url] = {'id': slug(item['name']), **item}

def public(record, key='benchmarkId'):
    return record[key] not in restricted_ids

snapshot = {'checkedAt': pricing['checkedAt'], 'models': model_records, 'benchmarks': [item for item in benchmarks if public(item, 'id')], 'results': [item for item in results if public(item)], 'reports': reports, 'sources': list(sources_by_url.values())}
path = ROOT / 'src' / 'lib' / 'snapshot.json'
path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + '\n')
payload = {'checkedAt': restricted['checkedAt'], 'benchmarks': [item for item in benchmarks if not public(item, 'id')], 'results': [item for item in results if not public(item)], 'sources': list(restricted_sources.values()), 'evidence': restricted['evidence'], 'attributions': restricted['attributions']}
payload_path = ROOT / '.local' / 'restricted' / 'payload.json'
payload_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n')
print(f"Saved {len(model_records)} model identities, {len(snapshot['benchmarks'])} benchmarks, {len(snapshot['results'])} results, {len(reports)} reports, {len(sources_by_url)} sources; {len(payload['benchmarks'])} restricted benchmarks with {len(payload['results'])} results in {payload_path.relative_to(ROOT)}.")
