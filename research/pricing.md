# Verified API pricing

Retrieved 16 November 2026. `pricing.json` contains 20 text-output models from five providers. Every record links to an official price table and model specification. This is a dated snapshot, not a live price feed.

The base figures are USD per million tokens for standard provider API service and short prompts. DeepSeek uses peak rates as the comparison baseline. They are not subscription charges, measured task costs or estimates of how many reasoning tokens a model will consume.

## Sources

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and the individual model pages establish GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna and GPT-6 Sol. Those are real identifiers; the previous prototype's values, rather than these identities, were invented.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [model overview](https://platform.claude.com/docs/en/models/overview) establish Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5. [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview) is explicitly active but legacy.
- [Gemini pricing](https://aistudio.google.com/docs/pricing) establishes Carbon, Argon, Hydrogen, 3.1 Flash-Lite and 3.1 Pro Preview. The JSON preserves the preview label. Gemini 4 context limits are unified input and output; the older two pages specify an input limit instead.
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) identifies the actual served versions behind the Flash and Pro API names. The legacy Flash aliases now serve V4.1 Flash; historical benchmark results for older versions must not be relabelled as the current version.
- [xAI pricing](https://docs.x.ai/developers/pricing) and the linked model pages establish Grok 4.7, Grok 4.3 and Grok Build 0.1. The public documentation now uses SpaceXSI branding; the dataset retains xAI as the provider grouping for the x.ai API.

## Data interpretation

`longContextPricing` records a threshold, its comparison operator and replacement token rates. `nextPricing` records the announced price change for Carbon and Argon on 1 December 2026. `offPeakPricing` supplies DeepSeek's alternate rates. An estimator that accepts large prompts should use these fields rather than silently applying the baseline price.

The xAI pricing table says long-context prices apply at **≥200K** tokens, while model-page prose says requests that exceed 200K. The snapshot follows the pricing table and records that discrepancy in the source limitations.

Cache-read prices exclude separately charged writes and storage. Output allowances and context limits do not predict completion speed. Provider descriptions are explicitly labelled as provider positioning, not independent recommendations.

No scores, per-task duration, success rate or model ranking were inferred from these prices. No restricted-access models, private account data or personal attribution were added. The official GPT-6 Terra documentation path returned 404; it was omitted rather than inferred from GPT-6.1 Terra.

## Validation

Parsed the JSON, checked 20 unique IDs, verified positive token prices and complete official links, and formatted both research files with Prettier. The final application should validate this data at its import boundary and keep its retrieval date visible.
