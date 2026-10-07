import pathlib
import tempfile
import unittest
from unittest import mock
import diagnostics


class DiagnosticContracts(unittest.TestCase):
    def test_request_query_and_credentials_are_redacted(self):
        text = diagnostics.redact_sensitive_text('GET /callback?code=abc&token=secret&word=apple Bearer jwt.token {"apiKey":"private"}')
        for value in ('code=abc', 'token=secret', 'jwt.token', 'private'):
            self.assertNotIn(value, text)
        self.assertIn('word=apple', text)
    def test_log_rotation_is_bounded_and_keeps_latest_diagnostic(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(diagnostics, 'MAX_LOG_BYTES', 10):
            path = pathlib.Path(root) / 'server.log'
            diagnostics.append_log(str(path), 'old diagnostic\n')
            diagnostics.append_log(str(path), 'new diagnostic\n')
            self.assertEqual('new diagnostic\n', path.read_text())
            self.assertEqual('old diagnostic\n', pathlib.Path(str(path) + '.previous').read_text())


if __name__ == '__main__': unittest.main()
