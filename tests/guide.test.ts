import assert from 'node:assert/strict';
import test from 'node:test';
import { guide, guideSchema, taskOptions } from '../src/lib/guide.ts';

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
