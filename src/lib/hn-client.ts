import { useCallback, useEffect, useState } from 'react';
import { hnClassifierCheck, hnResponseSchema } from './hn-schema';
import type { HnResponse, HnModelFeedback } from './hn-schema';
import { hnPublished, loadHnSnapshot } from './hn-published';

export { hnClassifierCheck, hnSentimentSchema } from './hn-schema';
export type { HnResponse } from './hn-schema';

export const hnSources = [
  {
    id: 'hn-archive',
    name: 'HN historical archive',
    url: 'https://huggingface.co/datasets/open-index/hacker-news',
    coverage: 'Monthly historical item records, including comments.',
    limitations:
      'Pinned archive snapshot; content can predate edits or deletions.',
  },
  {
    id: 'hn-recent-mirror',
    name: 'ClickHouse HN mirror',
    url: 'https://clickhouse.com/blog/clickhouse-release-25-04',
    coverage: 'Recent item records from the public hackernews_history table.',
    limitations:
      'Missing IDs fall back to the official API; mirror content can lag.',
  },
  {
    id: 'hn-official-items',
    name: 'Official Hacker News API',
    url: 'https://github.com/HackerNews/API',
    coverage: 'Public item lookups and historical ID gap checks.',
    limitations: 'Deleted and unavailable content cannot be recovered.',
  },
  {
    id: 'hn-local-classifier',
    name: `${hnClassifierCheck.modelName} local classifier`,
    url: hnClassifierCheck.modelUrl,
    coverage: 'Public model weights for automated sentiment classification.',
    limitations:
      'Experimental labels from masked context; see the local quality check.',
  },
].map((source) => ({
  ...source,
  kind: 'Local HN analysis',
  access: 'Public; no account required',
}));
const hnDateFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Australia/Hobart',
});
export function formatHnDate(date: string) {
  return hnDateFormat.format(new Date(date));
}
export function formatHnRange(start: string, end: string) {
  return hnDateFormat.formatRange(new Date(start), new Date(end));
}
export function feedbackCount(feedback: HnModelFeedback | undefined) {
  return feedback
    ? Object.values(feedback.counts).reduce((total, value) => total + value, 0)
    : 0;
}
export function useHnPipeline() {
  const [data, setData] = useState<HnResponse | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal, reload = false) => {
    try {
      if (hnPublished) {
        const { status, results, publishedAt } = await loadHnSnapshot(reload);
        if (signal?.aborted) return;
        setData({
          status,
          results,
          runner: {
            active: false,
            installed: false,
            runtimeReady: false,
            message: null,
          },
        });
        setPublishedAt(publishedAt);
        setError(null);
        return;
      }
      const response = await fetch('/api/hn', { signal });
      if (!response.ok)
        throw new Error('Local analysis service is unavailable.');
      const raw: unknown = await response.json();
      const parsed = hnResponseSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error('The local analysis status could not be validated.');
      setData(parsed.data);
      setError(null);
    } catch (failure) {
      if (!signal?.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Local analysis service is unavailable.',
        );
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    if (hnPublished) return () => controller.abort();
    const timer = setInterval(() => {
      void refresh(controller.signal);
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  async function refreshSnapshot() {
    setPending(true);
    try {
      await refresh(undefined, true);
    } finally {
      setPending(false);
    }
  }
  async function control(action: 'start' | 'pause') {
    if (hnPublished) return;
    setPending(true);
    try {
      const response = await fetch(`/api/hn/${action}`, { method: 'POST' });
      if (!response.ok)
        throw new Error(
          action === 'start'
            ? 'Could not start local analysis. Check the local service and model installation.'
            : 'Could not pause local analysis.',
        );
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Local analysis action failed.',
      );
    } finally {
      setPending(false);
    }
  }
  return { data, error, pending, control, publishedAt, refreshSnapshot };
}
export type HnPipeline = ReturnType<typeof useHnPipeline>;
