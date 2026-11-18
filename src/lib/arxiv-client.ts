import { useEffect, useState } from 'react';
import { arxivSnapshotSchema } from './arxiv-schema';
import type { ArxivSnapshot } from './arxiv-schema';

export type ArxivData =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; snapshot: ArxivSnapshot };

let shared: Promise<ArxivSnapshot> | null = null;

async function readSnapshot() {
  const response = await fetch('/arxiv-snapshot.json', {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Could not read the paper index.');
  const raw: unknown = await response.json();
  return arxivSnapshotSchema.parse(raw);
}

// Loaded once per session and shared by the Board, model pages and Papers
// page, on the first use by any of them.
function loadArxivSnapshot() {
  shared ??= readSnapshot().catch((error: unknown) => {
    shared = null;
    throw error;
  });
  return shared;
}

export function useArxivData(): ArxivData {
  const [data, setData] = useState<ArxivData>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    loadArxivSnapshot().then(
      (snapshot) => {
        if (current) setData({ status: 'ready', snapshot });
      },
      () => {
        if (current) setData({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, []);
  return data;
}
