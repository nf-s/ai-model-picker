"""Check the pre-upload checks against a synthetic site build."""

import json
import runpy
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

check_module = runpy.run_path(str(ROOT / 'scripts/check-site.py'))
site_report = check_module['site_report']
MUST_BE_ZERO = check_module['MUST_BE_ZERO']
CLAIM = 'Synthetic claim about the example model.'
TITLE = 'Synthetic story about the example model'
LOCAL_PATH = Path('/synthetic/checkout')
ARTICLE_URL = 'https://example.test/synthetic-article'
MEASURED = {'id': 'bm:synthetic-result', 'cls': 'measured', 'quote': ''}
NAMED_ID = 'ur:0123456789abcdef01234567/3'
PERSON = 'Ada Example'


class TestSiteCheck(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dist = Path(directory.name) / 'dist'
        (self.dist / 'assets').mkdir(parents=True)
        self.restricted = Path(directory.name) / 'payload.json'
        self.public = Path(directory.name) / 'snapshot.json'
        self.expert_catalog = Path(directory.name) / 'catalog.json'
        self.people = Path(directory.name) / 'people.json'
        self.write(self.people, {'version': 1, 'people': [{'name': PERSON}, {'name': 'Ben Sample'}]})
        self.write(self.expert_catalog, {'articles': [{'title': 'Example article', 'date': '2026-03-01', 'url': ARTICLE_URL}]})
        self.write(self.public, {'models': [{'id': 'example-model'}], 'sources': [{'id': 'shared-source'}]})
        self.write(self.restricted, {
            'benchmarks': [{'id': 'restricted-benchmark'}],
            'results': [{'id': 'restricted-result', 'modelId': 'example-model'}],
            'sources': [{'id': 'shared-source'}],
        })
        self.build()

    def write(self, path, value):
        path.write_text(json.dumps(value), encoding='utf-8')

    def build(self, second_release='release', claim=CLAIM, title=TITLE, script='const model = "example-model";'):
        self.write(self.dist / 'hn-snapshot.json', {'publishedAt': 'release', 'commentParts': 2})
        self.write(self.dist / 'hn-comments-1.json', {
            'publishedAt': 'release',
            'comments': [{'id': 2, 'claim': claim}, {'id': 1}],
            'stories': [{'id': 9, 'title': title}],
        })
        self.write(self.dist / 'hn-comments-2.json', {'publishedAt': second_release, 'comments': [{'id': 0}]})
        (self.dist / 'assets/index.js').write_text(script, encoding='utf-8')
        self.write(self.dist / 'core.json', {'measured': [MEASURED], 'namedBehindSignIn': True})
        self.search()

    def search(self, records=None):
        search = self.dist / 'search'
        for folder in ('t', 'a', 'r'):
            (search / folder).mkdir(parents=True, exist_ok=True)
        hn = {'id': 'hn:2', 'cls': 'crowd', 'src': 'hn', 'text': CLAIM, 'title': TITLE}
        records = [hn, MEASURED] if records is None else records
        head = {'v': 1, 'release': 'release'}
        self.write(search / 'index.json', {'version': 1, 'builtAt': 'release', 'records': len(records)})
        self.write(search / 't/0.json', {**head, 'terms': {'example': [0, 1], 'claim': [0]}})
        self.write(search / 'a/0.json', {**head, 'from': 0, 'docs': [[2, 0, -1, -1]] * len(records)})
        self.write(search / 'r/0.json', {**head, 'from': 0, 'records': records})

    def report(self, **options):
        return site_report(
            self.dist, self.restricted, self.public, (LOCAL_PATH,), self.expert_catalog, self.people, **options,
        )

    def failed(self, **options):
        report = self.report(**options)
        return [name for name in MUST_BE_ZERO if report[name]]

    def test_a_consistent_build_passes_with_its_totals(self):
        report = self.report()
        self.assertEqual(self.failed(), [])
        self.assertEqual(
            (report['commentFiles'], report['comments'], report['claimsAndTitles']), (2, 3, 2),
        )
        # An identifier that the public snapshot also holds is not a restricted one.
        self.assertEqual(report['restrictedOnlyIdentifiers'], 2)
        self.assertEqual(report['measuredRecords'], 1)

    def test_a_named_record_anywhere_in_the_build_blocks_an_upload(self):
        for record in (
            {'id': 'synthetic', 'cls': 'named'},
            {'id': NAMED_ID, 'cls': 'measured'},
            {'id': 'bm:synthetic', 'cls': 'measured', 'quote': 'Words a person wrote.'},
        ):
            with self.subTest(record=record):
                self.write(self.dist / 'core.json', {'measured': [MEASURED, record]})
                self.assertEqual(self.report()['namedRecords'], 1)
                self.assertEqual(self.failed(), ['namedRecords'])
        self.write(self.dist / 'core.json', {'measured': [MEASURED]})
        self.build(script=f'const record = "{NAMED_ID}";')
        self.assertEqual(self.failed(), ['namedRecords'])

    def test_the_private_named_file_blocks_an_upload(self):
        self.write(self.dist / 'named-private.json', {'use': []})
        self.assertEqual(self.failed(), ['namedFiles'])

    def test_a_person_named_in_static_output_blocks_an_upload(self):
        self.build(script=f'const person = "{PERSON}";')
        self.assertEqual(self.report()['personNames'], 1)
        self.assertEqual(self.failed(), ['personNames'])
        self.build()
        self.write(self.dist / 'core.json', {'measured': [MEASURED], 'note': f'{PERSON} and Ben Sample'})
        self.assertEqual(self.report()['personNames'], 2)

    def test_a_person_in_a_public_story_title_is_not_counted(self):
        self.build(title=f'A story by {PERSON}')
        self.assertEqual(self.report()['personNames'], 0)
        self.assertEqual(self.failed(), [])

    def test_the_search_index_is_checked_like_the_rest(self):
        report = self.report()
        self.assertEqual((report['searchFiles'], report['searchRecords']), (4, 2))
        self.assertGreater(report['searchWordBytes'], 0)
        hn = {'id': 'hn:2', 'cls': 'crowd', 'src': 'hn', 'text': f'{PERSON} said so.', 'title': f'A post by {PERSON}'}
        self.search([hn, MEASURED])
        self.assertEqual(self.failed(), [])
        self.search([hn, {**MEASURED, 'text': f'Reported by {PERSON}'}])
        self.assertEqual(self.failed(), ['personNames'])
        self.search([hn, {'id': NAMED_ID, 'cls': 'named', 'src': 'use'}])
        self.assertIn('namedRecords', self.failed())

    def test_a_search_file_from_another_build_blocks_an_upload(self):
        self.write(self.dist / 'search/t/0.json', {'v': 1, 'release': 'other', 'terms': {}})
        self.assertEqual(self.failed(), ['searchMixedReleases'])

    def test_a_missing_or_oversized_search_index_blocks_an_upload(self):
        self.assertEqual(self.failed(word_bytes=10), ['searchOverBudget'])
        self.assertEqual(self.failed(site_files=3), ['tooManyFiles'])
        (self.dist / 'search/index.json').unlink()
        self.assertEqual(self.failed(), ['searchIndexMissing'])

    def test_an_invalid_people_file_stops_the_check(self):
        self.write(self.people, {'version': 1, 'people': [{'name': ''}]})
        with self.assertRaises(ValueError):
            self.report()

    def test_a_part_from_another_export_is_counted(self):
        self.build(second_release='earlier-release')
        self.assertEqual(self.failed(), ['mixedReleases'])

    def test_contact_details_in_a_claim_or_a_title_are_counted(self):
        for text in ('Write to example.contact@example.test', 'See https://example.test/page', 'Ask @hidden-test-handle'):
            with self.subTest(text=text):
                self.build(claim=text)
                self.assertEqual(self.report()['personalDetails'], 1)
                self.build(claim=text, title=text)
                self.assertEqual(self.report()['personalDetails'], 2)
        self.assertEqual(self.failed(), ['personalDetails'])

    def test_an_identifier_found_only_in_the_restricted_results_is_counted(self):
        self.build(script='const results = ["restricted-result", "shared-source"];')
        self.assertEqual(self.report()['restrictedIdentifiers'], 1)
        self.assertEqual(self.failed(), ['restrictedIdentifiers'])

    def test_an_expert_article_link_or_catalog_file_blocks_a_static_build(self):
        self.build(script=f'const original = "{ARTICLE_URL}";')
        self.assertEqual(self.failed(), ['expertArticleLeaks'])
        self.build()
        self.write(self.dist / 'catalog.json', {'articles': []})
        self.assertEqual(self.failed(), ['expertArticleLeaks'])

    def test_an_expert_article_with_additional_fields_blocks_an_upload(self):
        self.write(self.expert_catalog, {
            'articles': [{'title': 'Example article', 'date': '2026-03-01', 'url': ARTICLE_URL, 'body': 'Example body.'}]
        })
        with self.assertRaises(ValueError):
            self.report()

    def test_a_file_over_the_limit_is_counted(self):
        size = max(path.stat().st_size for path in self.dist.rglob('*') if path.is_file())
        self.assertEqual(self.failed(file_bytes=size), [])
        self.assertEqual(self.failed(file_bytes=size - 1), ['oversizeFiles'])

    def test_a_path_on_this_computer_is_counted(self):
        self.build(script=f'const source = "{LOCAL_PATH}/src/App.tsx";')
        self.assertEqual(self.failed(), ['localPaths'])

    def test_a_missing_comment_file_stops_the_check(self):
        (self.dist / 'hn-comments-2.json').unlink()
        with self.assertRaises(OSError):
            self.report()


if __name__ == '__main__':
    unittest.main()
