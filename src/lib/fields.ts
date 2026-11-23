// The fields a record carries beside its job: where the model ran (setting),
// how it was run (run) and the kind of tool it was used in (surface). The
// records build sets them by rule (scripts/build-records.py); the filter bar
// filters Crowd and practitioner records by them, never measured results.

export const settingFilters = ['all', 'local', 'hosted'] as const;
export const runFilters = [
  'all',
  'unattended',
  'parallel',
  'interactive',
] as const;
export const surfaceFilters = [
  'all',
  'coding-agent',
  'chat-app',
  'api',
  'local-runner',
  'none',
] as const;
export type SettingFilter = (typeof settingFilters)[number];
export type RunFilter = (typeof runFilters)[number];
export type SurfaceFilter = (typeof surfaceFilters)[number];
export type FieldFilter = {
  setting: SettingFilter;
  run: RunFilter;
  surface: SurfaceFilter;
};
export const openFields: FieldFilter = {
  setting: 'all',
  run: 'all',
  surface: 'all',
};

// A record leaves the setting or run empty when nothing states it; the
// defaults are hosted and interactive, so an empty value counts as those.
export const settingLabels: Record<SettingFilter, string> = {
  all: 'Any setting',
  local: 'Local',
  hosted: 'Hosted or not stated',
};
export const runLabels: Record<RunFilter, string> = {
  all: 'Any run',
  unattended: 'Unattended',
  parallel: 'Parallel',
  interactive: 'Interactive or not stated',
};
export const surfaceLabels: Record<SurfaceFilter, string> = {
  all: 'Any surface',
  'coding-agent': 'Coding agent',
  'chat-app': 'Chat app',
  api: 'API',
  'local-runner': 'Local runner',
  none: 'Not stated',
};

// A surface's label, for a surface named in the job file.
export const surfaceName = (surface: string) =>
  Object.entries(surfaceLabels).find(([key]) => key === surface)?.[1] ??
  surface;

export function settingPasses(value: string, filter: SettingFilter) {
  if (filter === 'all') return true;
  return filter === 'local' ? value === 'local' : value !== 'local';
}

export function runPasses(value: string, filter: RunFilter) {
  if (filter === 'all') return true;
  return filter === 'interactive'
    ? value === '' || value === 'interactive'
    : value === filter;
}

export function surfacePasses(value: string, filter: SurfaceFilter) {
  if (filter === 'all') return true;
  return filter === 'none' ? value === '' : value === filter;
}

// Setting and run, which filter Crowd and practitioner records.
export const fieldsActive = (filter: FieldFilter) =>
  filter.setting !== 'all' || filter.run !== 'all';

export function fieldsPass(
  record: { setting: string; run: string; surface: string },
  filter: FieldFilter,
  // Surface filters only records that name a tool: practitioner records.
  withSurface: boolean,
) {
  return (
    settingPasses(record.setting, filter.setting) &&
    runPasses(record.run, filter.run) &&
    (!withSurface || surfacePasses(record.surface, filter.surface))
  );
}

// The setting and run of a Hacker News count, as core.json keys them:
// 'local|unattended'; '|' is the default.
export function cellPasses(cell: string, filter: FieldFilter) {
  const [setting = '', run = ''] = cell.split('|');
  return settingPasses(setting, filter.setting) && runPasses(run, filter.run);
}

// A record's stated fields as a line suffix: ' · setting local · run
// unattended · coding agent'; '' when none is set.
export function fieldsText(record: {
  setting: string;
  run: string;
  surface: string;
}) {
  return [
    record.setting && `setting ${record.setting}`,
    record.run && `run ${record.run}`,
    record.surface && surfaceName(record.surface).toLowerCase(),
  ]
    .filter(Boolean)
    .map((part) => ` · ${part}`)
    .join('');
}
