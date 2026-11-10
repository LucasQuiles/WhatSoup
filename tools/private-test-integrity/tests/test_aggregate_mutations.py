"""Confirm aggregate-limit regression tests detect removal of either limit."""
import ast
from pathlib import Path
import unittest
from unittest import mock

import test_private_scanner_candidate as regression


class AggregateMutationTests(unittest.TestCase):
    def run_removed_limit(self, expression):
        production = regression.scanner_candidate
        source = Path(production.__file__).read_text()
        tree = ast.parse(source)
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == 'select_candidate_blobs_from_github_tree')
        candidates = [node for node in ast.walk(function) if isinstance(node, ast.If)
                      and ast.unparse(node.test) == expression]
        self.assertEqual(len(candidates), 1)
        candidates[0].test = ast.Constant(value=False)
        mutant_tree = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
        namespace = dict(production.__dict__)
        exec(compile(mutant_tree, '<aggregate-limit-mutation>', 'exec'), namespace)
        case = regression.GitHubTreeBlobAdapterTests(
            'test_rejects_selected_count_or_total_overflow_before_fetch')
        result = unittest.TestResult()
        with mock.patch.object(production, function.name, namespace[function.name]):
            case.run(result)
        self.assertEqual(result.testsRun, 1)
        self.assertEqual(result.errors, [])
        self.assertEqual(result.skipped, [])
        return result

    def test_count_limit_removal_is_detected(self):
        result = self.run_removed_limit('len(selected) >= max_files')
        self.assertEqual(len(result.failures), 1, 'regression did not detect the removed count limit')

    def test_byte_limit_removal_is_detected(self):
        result = self.run_removed_limit('selected_total_bytes > max_total_bytes')
        self.assertEqual(len(result.failures), 1, 'regression did not detect the removed byte limit')
