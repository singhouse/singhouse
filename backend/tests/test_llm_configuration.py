# SPDX-License-Identifier: AGPL-3.0-only
"""Paging configuration and retained legacy request compatibility."""
from unittest.mock import patch

import pytest

from karaoke_backend.workers.llm_client import _read_api_key, paging_configured
from karaoke_backend.workers.llm_paging import page_word_sync, PAGING_STATUS_KEY, PAGING_UNAVAILABLE


@pytest.mark.parametrize('url,model,timeout,expected', [
    ('', 'local', '600', False),
    ('file:///tmp/model', 'local', '600', False),
    ('https://example.test/v1', 'local', '600', True),
    ('http://localhost:8080/v1', 'local', '600', True),
    ('https://example.test/v1', '', '600', False),
    ('https://example.test/v1', 'local', 'nan', False),
    ('https://example.test/v1', 'local', '0', False),
    ('https://example.test/v1', 'local', 'bad', False),
])
def test_paging_configuration(monkeypatch, url, model, timeout, expected):
    monkeypatch.setenv('KARAOKE_LLM_BASE_URL', url)
    monkeypatch.setenv('KARAOKE_LLM_MODEL', model)
    monkeypatch.setenv('KARAOKE_LLM_TIMEOUT', timeout)
    assert paging_configured() is expected


def test_modal_processing_alone_does_not_enable_paging(monkeypatch):
    monkeypatch.delenv('KARAOKE_LLM_BASE_URL', raising=False)
    monkeypatch.setenv('KARAOKE_MODAL', 'true')
    assert paging_configured() is False


def test_key_environment_precedence(monkeypatch, tmp_path):
    key_file = tmp_path / 'key'
    key_file.write_text('file-secret\n')
    monkeypatch.setenv('KARAOKE_LLM_API_KEY_FILE', str(key_file))
    monkeypatch.setenv('KARAOKE_LLM_API_KEY', ' environment-secret ')
    assert _read_api_key() == 'environment-secret'
    monkeypatch.delenv('KARAOKE_LLM_API_KEY')
    assert _read_api_key() == 'file-secret'


@pytest.mark.asyncio
async def test_unconfigured_paging_never_calls_endpoint(monkeypatch):
    monkeypatch.delenv('KARAOKE_LLM_BASE_URL', raising=False)
    word_data = {'lines': [[{'text': 'example', 'start': 1, 'end': 2}]]}
    with patch('karaoke_backend.workers.llm_paging.OpenAIChatClient') as client:
        result = await page_word_sync(word_data, 'example')
    client.assert_not_called()
    assert result['lines'] == word_data['lines']
    assert result['metadata'][PAGING_STATUS_KEY] == PAGING_UNAVAILABLE


def test_legacy_correction_option_is_ignored():
    from karaoke_backend.api.lyrics_sets import TranscribeRequest
    from karaoke_backend.jobs.transcribe import _pipeline_config
    body = TranscribeRequest.model_validate({'llm_correction': True})
    assert 'llm_correction' not in body.model_dump()
    config = _pipeline_config({'llm_correction': True, 'pipeline_config': {'correction': {'enabled': True}}})
    assert not hasattr(config, 'correction')


@pytest.mark.asyncio
async def test_feature_discovery_reports_configuration_without_credentials(monkeypatch, client):
    monkeypatch.delenv('KARAOKE_LLM_BASE_URL', raising=False)
    response = await client.get('/api/features')
    assert response.json()['llm_paging'] is False
    monkeypatch.setenv('KARAOKE_LLM_BASE_URL', 'https://example.test/v1')
    monkeypatch.setenv('KARAOKE_LLM_API_KEY', 'private-test-secret')
    response = await client.get('/api/features')
    assert response.json()['llm_paging'] is True
    assert 'private-test-secret' not in response.text
