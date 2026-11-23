import assert from 'node:assert/strict';
import test from 'node:test';
import {
  guide,
  guideBrief,
  guideGaps,
  guideSchema,
  taskOptions,
} from '../src/lib/guide.ts';
import { requestAdvice } from '../src/lib/named-client.ts';

test('regular chat recommendations use real app labels and cover both subscriptions', () => {
  for (const task of guide.tasks) {
    const options = taskOptions(task, 'chat');
    assert.ok(options.length >= 2, task.id);
    assert.ok(
      options.some((option) => option.choice.planId === 'chatgpt'),
      task.id,
    );
    assert.ok(
      options.some((option) => option.choice.planId === 'claude'),
      task.id,
    );
    assert.ok(
      options.every((option) =>
        ['ChatGPT', 'Claude'].includes(option.choice.surface),
      ),
    );
    assert.ok(options.some((option) => option.preferred));
  }
  const chat = guide.choices.find((choice) => choice.id === 'chat-high');
  assert.equal(chat?.name, 'GPT-6');
  assert.equal(chat?.modelId, 'gpt-6-sol');
});

test('coding workflows keep their agent models and effort separate from chat choices', () => {
  const coding = guide.tasks.filter((task) => task.codingDefault);
  assert.equal(coding.length, 3);
  for (const task of coding) {
    const options = taskOptions(task, 'coding');
    assert.ok(options.some((option) => option.choice.planId === 'chatgpt'));
    assert.ok(options.some((option) => option.choice.planId === 'claude'));
    assert.ok(
      options.every(
        (option) => !['ChatGPT', 'Claude'].includes(option.choice.surface),
      ),
    );
    assert.ok(options.some((option) => option.preferred));
  }
});

test('guide rejects broken evidence and model references', () => {
  const task = guide.tasks[0];
  const choice = guide.choices[0];
  assert.ok(task);
  assert.ok(choice);
  assert.equal(
    guideSchema.safeParse({
      ...guide,
      choices: [{ ...choice, modelId: 'unverified-model' }],
    }).success,
    false,
  );
  assert.equal(
    guideSchema.safeParse({
      ...guide,
      tasks: [
        { ...task, default: { choiceId: 'unverified-choice', why: 'Unknown' } },
      ],
    }).success,
    false,
  );
  assert.equal(
    guideSchema.safeParse({
      ...guide,
      tasks: [
        {
          ...task,
          evidence: [
            { kind: 'result', id: 'unverified-result', note: 'Unknown' },
          ],
        },
      ],
    }).success,
    false,
  );
});

test('each App guide task links to one brief, or to none with a reason, in both directions', async () => {
  const { default: jobFile } = await import('../research/jobs.json', {
    with: { type: 'json' },
  });
  const links = jobFile.guide.tasks;
  const jobs = jobFile.jobs;
  const taskIds = guide.tasks.map((task) => task.id);
  // Every guide task is listed once.
  assert.deepEqual(
    links.map((link) => link.task),
    taskIds,
  );
  // Task → job: the linked job names the task as its guide task.
  for (const task of taskIds) {
    const job = guideBrief(links, jobs, task);
    if (job) assert.equal(job.guideTask, task, task);
  }
  // Job → task: a job's guide task exists and links to a brief.
  for (const job of jobs) {
    if (!('guideTask' in job) || job.guideTask === undefined) continue;
    assert.ok(taskIds.includes(job.guideTask), job.id);
    assert.ok(guideBrief(links, jobs, job.guideTask), job.id);
  }
  // What has no counterpart, as a record of the current job file.
  assert.deepEqual(guideGaps(links, jobs), {
    tasksWithoutJob: ['subagents'],
    jobsWithoutTask: [
      'agents',
      'delegation',
      'planning',
      'extraction',
      'local',
    ],
  });
  assert.equal(guideBrief(links, jobs, 'subagents'), null);
  assert.equal(guideBrief(links, jobs, 'bug-fixes')?.id, 'bug-fix');
});

test('guide links follow the table, not a job id that looks alike', () => {
  const jobs = [
    { id: 'fixes', label: 'Fixes', guideTask: 'bug-fixes' },
    { id: 'bug-fixes', label: 'Bug fixes' },
  ];
  const links = [
    { task: 'bug-fixes', job: 'fixes' },
    { task: 'subagents', job: null },
  ];
  assert.equal(guideBrief(links, jobs, 'bug-fixes')?.id, 'fixes');
  assert.equal(guideBrief(links, jobs, 'subagents'), null);
  assert.equal(guideBrief(links, jobs, 'unknown'), null);
  assert.deepEqual(guideGaps(links, jobs), {
    tasksWithoutJob: ['subagents'],
    jobsWithoutTask: ['bug-fixes'],
  });
});

test('the App guide’s method advice makes no request without a session', () => {
  const calls: string[] = [];
  const fetcher = async (input: string) => {
    calls.push(input);
    return new Response('{}', { status: 200 });
  };
  for (const access of [
    { kind: 'anonymous' },
    { kind: 'unavailable' },
  ] as const)
    assert.equal(requestAdvice(access, fetcher), null);
  assert.deepEqual(calls, []);
});
