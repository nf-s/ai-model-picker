# Verified API pricing

Retrieved 21 November 2026. `pricing.json` contains 23 text-output models from five providers: seven OpenAI, five Anthropic, six Google, two DeepSeek and three xAI. Every record links to an official price table and model specification. This is a dated snapshot, not a live price feed.

The base figures are USD per million tokens for standard provider API service and short prompts. DeepSeek uses peak rates as the comparison baseline. They are not subscription charges, measured task costs or estimates of how many reasoning tokens a model will consume.

## Sources

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and the individual model pages establish GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna and GPT-6 Sol. Those are real identifiers; the previous prototype's values, rather than these identities, were invented. The OpenAI changelog dates GPT-6.2 Astra and GPT-6.2 Sol to 17 November 2026. The model catalog now features GPT-6.2 Astra, GPT-6.2 Sol, GPT-6.1 Terra and GPT-6 Luna and lists GPT-6 Astra and GPT-6.1 Sol under more models; neither page calls them legacy, so both stay current.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [model overview](https://platform.claude.com/docs/en/models/overview) establish Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5. [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview) is explicitly active but legacy. Claude Mythos 5.2 has the same rates as Fable 5.2 but is limited to verified organizations, so it is not included.
- [Gemini pricing](https://aistudio.google.com/docs/pricing) establishes Carbon, Argon, Neon, Hydrogen, 3.1 Flash-Lite and 3.1 Pro Preview. The Gemini changelog dates Neon to 18 November 2026. The JSON preserves the preview label. Gemini 4 context limits are unified input and output; the older two pages specify an input limit instead.
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) identifies the actual served versions behind the Flash and Pro API names. The legacy Flash aliases now serve V4.1 Flash; historical benchmark results for older versions must not be relabelled as the current version.
- [xAI pricing](https://docs.x.ai/developers/pricing) and the linked model pages establish Grok 4.7 and Grok 4.3. Grok Build 0.1 keeps the rates read on 16 November 2026; see the discrepancies below. The public documentation now uses SpaceXSI branding; the dataset retains xAI as the provider grouping for the x.ai API.

## Status

`status` is `previous` when a newer model of the same line exists or the provider names a replacement: GPT-6 Astra and GPT-6.1 Sol (replaced by GPT-6.2 Astra and Sol), Gemini 3.1 Flash-Lite (Google names Gemini 3.5 Flash-Lite as its replacement) and Grok Build 0.1 (no longer in the xAI price table) became `previous` on 21 November 2026. Models without a price record take their status from [model-status.json](model-status.json), with a reason for each.

## Data interpretation

`longContextPricing` records a threshold, its comparison operator and replacement token rates. `nextPricing` records the announced price change for Carbon and Argon on 1 December 2026. `offPeakPricing` supplies DeepSeek's alternate rates. An estimator that accepts large prompts should use these fields rather than silently applying the baseline price.

Cache-read prices exclude separately charged writes and storage. Output allowances and context limits do not predict completion speed. Provider descriptions are explicitly labelled as provider positioning, not independent recommendations.

No scores, per-task duration, success rate or model ranking were inferred from these prices. No restricted-access models, private account data or personal attribution were added. The official GPT-6 Terra documentation path returned 404; it was omitted rather than inferred from GPT-6.1 Terra.

## Discrepancies between provider pages

- **xAI long-context threshold.** The pricing table and the Grok 4.7 and Grok 4.3 model pages apply long-context rates once a prompt reaches 200K tokens (**≥200K**). The Grok 4.7 release note and the US regional endpoint section say above 200K, and the Grok 4.7 Fast section says exceeds 200K. The snapshot follows the pricing table.
- **Grok Build 0.1.** On 21 November 2026 the xAI pricing table no longer listed `grok-build-0.1` and its model page redirected to the model list. No retirement notice was found, so the record keeps its 16 November rates and says so in its notes. The May 2026 retirement guide routes `grok-code-fast-1` to Grok 4.3, which contradicts the earlier note that grok-code-fast aliases resolve to Grok Build 0.1; that note was removed.
- **Gemini 3.1 Flash-Lite.** The Gemini deprecations page lists a shutdown no earlier than 7 May 2027 with Gemini 3.5 Flash-Lite as the replacement, while the model list labels it Stable. It stays current.

## Validation

Parsed the JSON and checked 23 unique IDs, positive token prices and an official price and model link for every record; Grok Build 0.1's model link now redirects. The final application should validate this data at its import boundary and keep its retrieval date visible.
