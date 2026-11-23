// Credits and licence terms for material shown on the site. `checkedAt` is
// the day the entry was checked against the source's licence or terms page.

export type Attribution = {
  source: string;
  material: string;
  url: string;
  licence: { name: string; url: string } | null;
  credit: string;
  changes: string | null;
  checkedAt: string;
};

const ccBy = {
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
};

export const attributions: Attribution[] = [
  {
    source: 'Epoch AI',
    material: 'Epoch Capabilities Index scores and credible intervals',
    url: 'https://epoch.ai/eci',
    licence: ccBy,
    credit:
      "Epoch AI, 'Epoch Capabilities Index'. Published online at epoch.ai. Retrieved from https://epoch.ai/eci. Accessed 21 November 2026.",
    changes:
      'A subset of models, with names matched to this site’s model list and scores reformatted.',
    checkedAt: '2026-11-18',
  },
  {
    source: 'Epoch AI benchmarking hub',
    material: 'Results of Epoch AI’s own benchmark runs',
    url: 'https://epoch.ai/benchmarks/use-this-data',
    licence: ccBy,
    credit:
      'Epoch AI, ‘Capabilities & benchmarking’. Published online at epoch.ai. Retrieved from ‘https://epoch.ai/benchmarks’ [online resource]. Accessed 23 November 2026. Licensed under CC BY 4.0.',
    changes:
      'Epoch’s own runs of selected benchmarks only; results Epoch copies from other sources are not used. Models matched to this site’s model list by exact name, scores shown as percentages with a 95% interval from the standard error.',
    checkedAt: '2026-11-23',
  },
  {
    source: 'LMArena',
    material:
      'Arena leaderboard dataset: ratings, confidence bounds, vote counts and ranks',
    url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    licence: ccBy,
    credit:
      'Source: Arena leaderboard dataset (huggingface.co/datasets/lmarena-ai/leaderboard-dataset), latest split as published 9–22 November 2026. Licensed under CC BY 4.0.',
    changes:
      'Selected leaderboards from the latest split. Models matched to this site’s model list by exact name, with the effort setting and harness read from the name; ratings rounded.',
    checkedAt: '2026-11-23',
  },
  {
    source: 'OpenRouter',
    material:
      'Usage from the OpenRouter Data API: 30-day token shares per model and 7-day task tags with their top models',
    url: 'https://openrouter.ai/rankings',
    licence: ccBy,
    credit:
      'Source: OpenRouter (openrouter.ai/rankings), as of 2026-11-23T02:56:32.003Z. Licensed under CC BY 4.0.',
    changes:
      'Routes matched to this site’s model list by exact name, a free route counted with its model; token totals summed over the period. Usage only: it orders nothing.',
    checkedAt: '2026-11-23',
  },
  {
    source: 'SWE-rebench Team',
    material: 'SWE-rebench leaderboard results, 15 May–1 July 2026',
    url: 'https://huggingface.co/datasets/nebius/SWE-rebench-leaderboard',
    licence: ccBy,
    credit:
      'SWE-rebench (swe-rebench.com). Badertdinov et al., 2025, arXiv:2505.20411.',
    changes:
      'Model-only rows from one evaluation window, with model names matched and scores reformatted.',
    checkedAt: '2026-11-18',
  },
  {
    source: 'TokenSave',
    material: 'Effort, cost and coding experiment datasets',
    url: 'https://tokensave.app/data/claude-effort-cost',
    licence: ccBy,
    credit:
      'Source: TokenSave (tokensave.app). Each report links to its dataset page.',
    changes: 'Findings summarised in this site’s words; figures rounded.',
    checkedAt: '2026-11-18',
  },
  {
    source: 'Terminal-Bench',
    material: 'Terminal-Bench 4.1 leaderboard runs',
    url: 'https://www.tbench.ai/',
    licence: {
      name: 'Apache-2.0 (benchmark code)',
      url: 'https://github.com/laude-institute/terminal-bench/blob/main/LICENSE',
    },
    credit: 'Terminal-Bench leaderboard (tbench.ai).',
    changes: 'Selected runs, with model names matched and costs derived.',
    checkedAt: '2026-11-18',
  },
  {
    source: 'Plato Technologies',
    material: 'Plato Web Clone Bench results',
    url: 'https://plato.so/research/web-clone-bench/',
    licence: null,
    credit:
      'Plato Web Clone Bench (plato.so). No data licence is stated; results are cited with a link.',
    changes: 'Best reported effort per model.',
    checkedAt: '2026-11-18',
  },
  {
    source: 'Contra Labs and other report publishers',
    material: 'Findings from published reports',
    url: 'https://contralabs.com/research',
    licence: null,
    credit:
      'Each report is summarised in this site’s words and links to the original.',
    changes: null,
    checkedAt: '2026-11-18',
  },
  {
    source: 'Hacker News (Y Combinator)',
    material:
      'Comment and story IDs, timestamps and, on request, comment text loaded from the official API',
    url: 'https://github.com/HackerNews/API',
    licence: null,
    credit:
      'Hacker News data is provided by Y Combinator. Comments are the work of their authors. Sentiment labels and summaries are generated by this site’s classifier.',
    changes:
      'Author fields are omitted. Labels, story titles and claims are machine-generated or scrubbed.',
    checkedAt: '2026-11-18',
  },
  {
    source: 'open-index on Hugging Face',
    material: 'Hacker News archive used to find comments',
    url: 'https://huggingface.co/datasets/open-index/hacker-news',
    licence: {
      name: 'ODC-By 1.0',
      url: 'https://opendatacommons.org/licenses/by/1-0/',
    },
    credit:
      'open-index/hacker-news, an independent mirror. Hacker News data is provided by Y Combinator.',
    changes: 'Only IDs, timestamps and derived labels are published.',
    checkedAt: '2026-11-18',
  },
  {
    source: 'OpenAI, Anthropic, Google, DeepSeek and xAI',
    material: 'API prices, model specifications and app documentation',
    url: 'https://developers.openai.com/api/docs/pricing',
    licence: null,
    credit:
      'Quoted from each provider’s public documentation, linked from every price and in the source list. Product names are trademarks of their owners.',
    changes: null,
    checkedAt: '2026-11-18',
  },
];
