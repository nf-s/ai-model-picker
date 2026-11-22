import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adviceForTask,
  findingsForTarget,
  practitionerFamilies,
  practitionerReview,
  practitionerSchema,
} from '../src/lib/practitioner.ts';

test('model findings require the exact model or family and guide advice stays with its task', () => {
  const exact = findingsForTarget({ kind: 'model', target: 'claude-opus-5-5' });
  const family = findingsForTarget({ kind: 'family', target: 'Claude' });
  const toolName = findingsForTarget({ kind: 'family', target: 'Claude Chat' });
  const anotherVersion = findingsForTarget({
    kind: 'model',
    target: 'claude-opus-5',
  });
  assert.ok(exact.length > 0 && family.length > 0);
  assert.ok(practitionerFamilies.includes('Claude'));
  assert.ok(exact.every((entry) => !family.includes(entry)));
  assert.deepEqual(toolName, []);
  assert.deepEqual(anotherVersion, []);
  for (const taskId of ['web-apps', 'bug-fixes', 'subagents']) {
    const advice = adviceForTask(taskId);
    assert.ok(advice.length > 0);
    assert.ok(advice.every((entry) => entry.taskId === taskId));
  }
  assert.deepEqual(adviceForTask('unknown'), []);
});

test('the public practitioner schema rejects raw excerpts, tool-only model findings and unrecognised sources', () => {
  const finding = practitionerReview.findings.find(
    (entry) => entry.kind !== 'workflow advice',
  );
  assert.ok(finding);
  for (const invalid of [
    { ...finding, quote: 'Private review field' },
    { ...finding, targets: [{ kind: 'tool', id: 'Claude Chat' }] },
    { ...finding, targets: [{ kind: 'model', id: 'untracked-model' }] },
    { ...finding, sourceUrl: 'https://example.com/' },
    { ...finding, contextUrl: finding.sourceUrl },
    { ...finding, kind: 'workflow advice', taskId: 'unknown' },
  ]) {
    assert.equal(
      practitionerSchema.safeParse({
        ...practitionerReview,
        findings: [invalid],
      }).success,
      false,
    );
  }
});
