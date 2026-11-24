import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { z } from 'zod';
import { jobRules, noJobTag } from '../src/lib/job-rules.ts';
import { peopleSchema, recordSchema } from '../src/lib/records.ts';
import drawingCases from './fixtures/drawing-test.json' with { type: 'json' };
import recordFixtures from './fixtures/records.json' with { type: 'json' };
import peopleFixtures from './fixtures/people.json' with { type: 'json' };

const object = z.record(z.string(), z.unknown());
const fixtureSchema = z.object({
  valid: z.array(object),
  invalid: z.array(
    z.object({
      why: z.string(),
      base: z.number().int().nullable(),
      person: z.number().int().optional(),
      patch: object.optional(),
      omit: z.array(z.string()).optional(),
      value: z.unknown().optional(),
    }),
  ),
});

type Case = { why: string; value: unknown; valid: boolean };

function cases(raw: unknown, nested: 'people' | null): Case[] {
  const fixtures = fixtureSchema.parse(raw);
  const out: Case[] = fixtures.valid.map((value, index) => ({
    why: `valid ${index}`,
    value,
    valid: true,
  }));
  for (const item of fixtures.invalid) {
    if (item.base === null) {
      out.push({ why: item.why, value: item.value, valid: false });
      continue;
    }
    const base = fixtures.valid[item.base];
    assert.ok(base, item.why);
    let value: Record<string, unknown>;
    if (nested && item.person !== undefined) {
      const people = z.array(object).parse(base[nested]);
      const person = people[item.person];
      assert.ok(person, item.why);
      const changed = { ...person, ...item.patch };
      value = {
        ...base,
        [nested]: people.map((entry, index) =>
          index === item.person ? changed : entry,
        ),
      };
    } else {
      value = { ...base, ...item.patch };
    }
    for (const field of item.omit ?? []) delete value[field];
    out.push({ why: item.why, value, valid: false });
  }
  return out;
}

const records = cases(recordFixtures, null);
const people = cases(peopleFixtures, 'people');

test('the Zod schemas accept the valid fixtures and reject the invalid ones', () => {
  for (const item of records)
    assert.equal(
      recordSchema.safeParse(item.value).success,
      item.valid,
      item.why,
    );
  for (const item of people)
    assert.equal(
      peopleSchema.safeParse(item.value).success,
      item.valid,
      item.why,
    );
});

test('the Python validator gives the same verdict as the Zod schema on every fixture', () => {
  const run = spawnSync('python3', ['-B', 'scripts/records_schema.py'], {
    input: JSON.stringify({
      records: records.map((item) => item.value),
      people: people.map((item) => item.value),
    }),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const verdicts = z
    .object({ records: z.array(z.boolean()), people: z.array(z.boolean()) })
    .parse(JSON.parse(run.stdout));
  assert.deepEqual(
    verdicts.records.map((valid, index) => [records[index]?.why, valid]),
    records.map((item) => [item.why, item.valid]),
  );
  assert.deepEqual(
    verdicts.people.map((valid, index) => [people[index]?.why, valid]),
    people.map((item) => [item.why, item.valid]),
  );
});

// tests/test_records.py checks the same texts against the same pattern with
// Python's re, which the records build uses to set the tag.
test('JavaScript reads the drawing-test pattern as the build does on the shared cases', () => {
  const rule = jobRules.tags.rules.find(
    (entry) => entry.tag === 'drawing-test',
  );
  assert.ok(rule);
  assert.equal(rule.noJob, true);
  const pattern = new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i');
  for (const text of drawingCases.tagged) assert.ok(pattern.test(text), text);
  for (const text of drawingCases.untagged)
    assert.ok(!pattern.test(text), text);
  const run = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      [
        'import json, re, sys',
        'rule = json.load(open("research/jobs.json"))["tags"]["rules"][0]',
        'pattern = re.compile(rule["pattern"], 0 if rule["caseSensitive"] else re.I)',
        'print(json.dumps([bool(pattern.search(text)) for text in json.load(sys.stdin)]))',
      ].join('\n'),
    ],
    {
      input: JSON.stringify([...drawingCases.tagged, ...drawingCases.untagged]),
      encoding: 'utf8',
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    z.array(z.boolean()).parse(JSON.parse(run.stdout)),
    [...drawingCases.tagged, ...drawingCases.untagged].map((text) =>
      pattern.test(text),
    ),
  );
  assert.equal(noJobTag(['drawing-test']), 'drawing-test');
  assert.equal(noJobTag(['other']), '');
});
