import { Fragment, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
import { guide, taskOptions } from '../lib/guide';
import type { AppChoice, AppFilter, ChoiceMode, GuideTask } from '../lib/guide';
import {
  benchmarks,
  models,
  reports,
  restrictedEvidence,
  results,
} from '../lib/data';
import { modelHref } from '../lib/route';
import { adviceForTask } from '../lib/practitioner';
import {
  benchmarkLabel,
  formatScore,
  insightFor,
  modelKey,
} from '../lib/site-data';
import type { HnData } from '../lib/site-data';
import type { Scope } from '../lib/model-filter';
import PractitionerFindings from './PractitionerFindings';
import './app-guide.css';

type PlanId = 'chatgpt' | 'claude';

function appName(planId: PlanId, mode: ChoiceMode) {
  if (planId === 'chatgpt') return mode === 'chat' ? 'ChatGPT' : 'Codex';
  return mode === 'chat' ? 'Claude' : 'Claude Code';
}

function settingText(choice: AppChoice) {
  const effort = ['Low', 'Medium', 'High', 'Extra High'].includes(
    choice.setting,
  );
  if (!effort) return choice.setting;
  const prefix =
    choice.planId === 'claude'
      ? 'Effort'
      : choice.surface === 'ChatGPT'
        ? 'Thinking'
        : 'Reasoning';
  return `${prefix}: ${choice.setting}`;
}

// A plan follows the filter through the providers of the models it offers.
function planProviders(planId: PlanId) {
  return [
    ...new Set(
      guide.choices.flatMap((choice) => {
        if (choice.planId !== planId || !choice.modelId) return [];
        const modelId = choice.modelId;
        const model = models.find((entry) => entry.id === modelId);
        return model ? [model.provider] : [];
      }),
    ),
  ];
}

const providersByPlan = new Map(
  guide.plans.map((plan) => [plan.id, planProviders(plan.id)]),
);

function sourceFor(id: string) {
  return guide.sources.find((entry) => entry.id === id);
}

function ModelLink({ choice, hn }: { choice: AppChoice; hn: HnData }) {
  const modelId = choice.modelId;
  if (!modelId) return null;
  const model = models.find((entry) => entry.id === modelId);
  const total = insightFor(hn, modelKey(modelId))?.total;
  return (
    <span className="rd-ag-model">
      <a href={modelHref(modelId)}>{model?.name ?? modelId}</a>
      {hn.status === 'ready' && total ? (
        <span className="rd-muted">
          {' '}
          · {total.toLocaleString()} HN comments
        </span>
      ) : null}
    </span>
  );
}

function Choice({
  choice,
  note,
  hn,
}: {
  choice: AppChoice | undefined;
  note?: string;
  hn: HnData;
}) {
  if (!choice) return <span className="rd-muted">No verified option</span>;
  return (
    <div className="rd-ag-choice">
      <strong>{choice.name}</strong>
      <span className="rd-ag-setting">{settingText(choice)}</span>
      {note && <span className="rd-ag-setting">{note}</span>}
      <ModelLink choice={choice} hn={hn} />
    </div>
  );
}

// Evidence from benchmarks that cannot be republished is added only when an
// approved account has loaded it.
function taskEvidence(task: GuideTask) {
  return [
    ...restrictedEvidence.filter((item) => item.taskId === task.id),
    ...task.evidence,
  ];
}

function Evidence({ task }: { task: GuideTask }) {
  const evidence = taskEvidence(task);
  return (
    <div className="rd-ag-evidence">
      <h4 className="rd-h">Supporting evidence ({evidence.length})</h4>
      <ul>
        {evidence.map((item) => {
          const result =
            item.kind === 'result'
              ? results.find((entry) => entry.id === item.id)
              : undefined;
          const report =
            item.kind === 'report'
              ? reports.find((entry) => entry.id === item.id)
              : undefined;
          const benchmark = benchmarks.find(
            (entry) => entry.id === result?.benchmarkId,
          );
          const model = models.find((entry) => entry.id === result?.modelId);
          const href = result?.sourceUrl ?? report?.url;
          const name = benchmark ? benchmarkLabel(benchmark) : report?.title;
          return (
            <li key={item.id}>
              <div>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {name}
                    <ArrowUpRight size={12} />
                  </a>
                ) : (
                  <strong>{name}</strong>
                )}
                {result && benchmark && (
                  <span className="rd-muted">
                    {' '}
                    · {model ? `${model.name} · ` : ''}
                    {formatScore(result.score, benchmark)}
                  </span>
                )}
              </div>
              <p>{item.note}</p>
              <p className="rd-note">
                {report?.limitation ?? benchmark?.methodology}
              </p>
              {result && (
                <p className="rd-note">
                  Tested configuration: {result.configuration}. App behavior can
                  differ from this evaluation setup.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Detail({
  task,
  mode,
  app,
  hn,
  onCoding,
}: {
  task: GuideTask;
  mode: ChoiceMode;
  app: AppFilter;
  hn: HnData;
  onCoding: () => void;
}) {
  const options = taskOptions(task, mode).filter(
    (option) => app === 'both' || option.choice.planId === app,
  );
  const advice = mode === 'coding' ? adviceForTask(task.id) : [];
  const workOptions = task.alternatives.flatMap((option) => {
    const choice = guide.choices.find((entry) => entry.id === option.choiceId);
    return choice?.surface === 'ChatGPT Work' ? [{ ...option, choice }] : [];
  });
  const sources = [
    ...new Set(options.flatMap((option) => option.choice.sourceIds)),
  ].flatMap((id) => {
    const source = sourceFor(id);
    return source ? [source] : [];
  });
  return (
    <div className="rd-ag-detail">
      <h3 className="rd-h">{task.label}: alternatives</h3>
      <ul className="rd-ag-options">
        {options.map((option) => (
          <li key={option.choice.id}>
            <div>
              <span className="rd-muted">{option.choice.surface}</span>
              <strong>
                {option.choice.name}
                <small>{option.choice.setting}</small>
              </strong>
              {option.preferred && (
                <span className="rd-ag-tag">Suggested start</span>
              )}
              <ModelLink choice={option.choice} hn={hn} />
            </div>
            <div>
              <p>{option.when}</p>
              {option.tradeoff && <p className="rd-note">{option.tradeoff}</p>}
              <p className="rd-note">{option.choice.summary}</p>
            </div>
          </li>
        ))}
      </ul>
      {mode === 'chat' && app !== 'claude' && workOptions.length > 0 && (
        <div className="rd-ag-extra">
          <h4 className="rd-h">Also available in ChatGPT Work</h4>
          <ul>
            {workOptions.map((option) => (
              <li key={option.choice.id}>
                <strong>
                  {option.choice.name} · {option.choice.setting}
                </strong>
                <p>
                  {option.when} {option.tradeoff}
                </p>
                <p className="rd-note">{option.choice.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {mode === 'chat' && task.codingDefault && (
        <p className="rd-ag-switch">
          <span>Working in a repository with files and tests?</span>
          <button type="button" className="rd-button" onClick={onCoding}>
            See coding-agent choices
            <ChevronRight size={13} />
          </button>
        </p>
      )}
      {taskEvidence(task).length > 0 && <Evidence task={task} />}
      {advice.length > 0 && (
        <section
          className="rd-ag-extra"
          aria-labelledby={`rd-ag-advice-${task.id}`}
        >
          <h4 className="rd-h" id={`rd-ag-advice-${task.id}`}>
            Practitioner advice
          </h4>
          <PractitionerFindings findings={advice} heading="h5" />
        </section>
      )}
      {sources.length > 0 && (
        <p className="rd-ag-sources">
          <span className="rd-muted">Sources</span>
          {sources.map((source) => (
            <a
              key={source.id}
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              {source.name}
              <ArrowUpRight size={12} />
            </a>
          ))}
        </p>
      )}
    </div>
  );
}

export default function AppGuide({ hn, scope }: { hn: HnData; scope: Scope }) {
  const [mode, setMode] = useState<ChoiceMode>('chat');
  const [chosenApp, setApp] = useState<AppFilter>('both');
  const [openTask, setOpenTask] = useState<string | null>(null);
  const plans = guide.plans.filter((plan) =>
    (providersByPlan.get(plan.id) ?? []).some((provider) =>
      scope.provider(provider),
    ),
  );
  const only = plans.length === 1 ? plans[0] : undefined;
  const app: AppFilter = only ? only.id : chosenApp;
  const tasks = guide.tasks.filter(
    (task) => mode === 'chat' || task.codingDefault,
  );
  const columns = app === 'both' ? 4 : 3;
  function chooseMode(next: ChoiceMode) {
    setMode(next);
    setOpenTask(null);
  }
  const head = (
    <header className="rd-page-head">
      <h1>App guide</h1>
      <p>
        ChatGPT and Claude · highest-usage plans · checked {guide.checkedAt}
      </p>
    </header>
  );
  if (plans.length === 0)
    return (
      <div className="rd-page rd-ag">
        {head}
        <p className="rd-note">
          The App guide covers ChatGPT and Claude; neither is in the model
          filter.
        </p>
      </div>
    );
  return (
    <div className="rd-page rd-ag">
      {head}
      <div className="rd-ag-controls">
        <div className="rd-seg" role="group" aria-label="Workflow">
          <button
            type="button"
            aria-pressed={mode === 'chat'}
            onClick={() => chooseMode('chat')}
          >
            Chat apps
          </button>
          <button
            type="button"
            aria-pressed={mode === 'coding'}
            onClick={() => chooseMode('coding')}
          >
            Coding agents
          </button>
        </div>
        {!only && (
          <select
            className="rd-select"
            aria-label="App"
            value={app}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'both' || value === 'chatgpt' || value === 'claude')
                setApp(value);
            }}
          >
            <option value="both">Both apps</option>
            <option value="chatgpt">{appName('chatgpt', mode)}</option>
            <option value="claude">{appName('claude', mode)}</option>
          </select>
        )}
      </div>
      <section className="rd-section" aria-labelledby="rd-ag-plans">
        <h2 className="rd-h" id="rd-ag-plans">
          Plans
        </h2>
        <div className="rd-ag-plans">
          {plans.map((plan) => (
            <article key={plan.id} className="rd-panel rd-ag-plan">
              <h3>{plan.name}</h3>
              <p>{plan.usage}</p>
              <p className="rd-ag-sources">
                {plan.sourceIds.flatMap((id) => {
                  const source = sourceFor(id);
                  return source
                    ? [
                        <a
                          key={id}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {source.name}
                          <ArrowUpRight size={12} />
                        </a>,
                      ]
                    : [];
                })}
              </p>
            </article>
          ))}
        </div>
      </section>
      <section className="rd-section" aria-labelledby="rd-ag-tasks">
        <h2 className="rd-h" id="rd-ag-tasks">
          Tasks
        </h2>
        <div className="rd-panel rd-ag-panel">
          <table className="rd-table rd-ag-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                {app !== 'claude' && (
                  <th scope="col">
                    {mode === 'chat'
                      ? 'In ChatGPT, select'
                      : 'In Codex, select'}
                  </th>
                )}
                {app !== 'chatgpt' && (
                  <th scope="col">
                    {mode === 'chat'
                      ? 'In Claude, select'
                      : 'In Claude Code, select'}
                  </th>
                )}
                <th scope="col">Suggested starting point</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const options = taskOptions(task, mode);
                const chatgpt = options.find(
                  (option) => option.choice.planId === 'chatgpt',
                );
                const claude = options.find(
                  (option) => option.choice.planId === 'claude',
                );
                const preferred = options.find(
                  (option) => app === 'both' || option.choice.planId === app,
                );
                const open = openTask === task.id;
                return (
                  <Fragment key={task.id}>
                    <tr className={open ? 'rd-ag-open' : undefined}>
                      <th scope="row" className="rd-ag-task">
                        <button
                          type="button"
                          id={`rd-ag-task-${task.id}`}
                          aria-expanded={open}
                          aria-controls={`rd-ag-detail-${task.id}`}
                          onClick={() => setOpenTask(open ? null : task.id)}
                        >
                          {open ? (
                            <ChevronDown size={14} />
                          ) : (
                            <ChevronRight size={14} />
                          )}
                          {task.label}
                        </button>
                      </th>
                      {app !== 'claude' && (
                        <td data-label={appName('chatgpt', mode)}>
                          <Choice choice={chatgpt?.choice} hn={hn} />
                        </td>
                      )}
                      {app !== 'chatgpt' && (
                        <td data-label={appName('claude', mode)}>
                          <Choice
                            choice={claude?.choice}
                            note={
                              mode === 'chat' && task.id === 'subagents'
                                ? 'Research only; no manual worker controls'
                                : undefined
                            }
                            hn={hn}
                          />
                        </td>
                      )}
                      <td data-label="Start with">
                        {preferred && (
                          <>
                            <strong>
                              {appName(preferred.choice.planId, mode)}
                            </strong>
                            <p>{preferred.when}</p>
                          </>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr
                        className="rd-ag-detail-row"
                        id={`rd-ag-detail-${task.id}`}
                      >
                        <td colSpan={columns}>
                          <Detail
                            task={task}
                            mode={mode}
                            app={app}
                            hn={hn}
                            onCoding={() => chooseMode('coding')}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
