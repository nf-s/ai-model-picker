import { z } from 'zod';

const articleSchema = z
  .strictObject({
    title: z.string().trim().min(1),
    date: z.iso.date(),
    url: z
      .url({
        protocol: /^https$/,
        hostname: z.regexes.domain,
      })
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash;
      }),
  })
  .transform((article) => ({
    ...article,
    source: new URL(article.url).hostname.replace(/^www\./, ''),
  }));

const catalogSchema = z.strictObject({ articles: z.array(articleSchema) });

export type ExpertArticle = z.infer<typeof articleSchema>;

export type ExpertArticlesResult =
  { kind: 'sign-in' } | { kind: 'ready'; articles: ExpertArticle[] };

export async function loadExpertArticles(
  signal: AbortSignal,
): Promise<ExpertArticlesResult> {
  const response = await fetch('/api/expert-articles', {
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) return { kind: 'sign-in' };
  if (!response.ok) throw new Error('The article catalog is unavailable.');
  const { articles } = catalogSchema.parse(await response.json());
  return {
    kind: 'ready',
    articles: articles.sort(
      (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
    ),
  };
}
