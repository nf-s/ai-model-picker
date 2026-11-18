"""Review public comments with a Claude model through the Anthropic API, one at a time or in batches."""

from collections import Counter
from threading import Lock

import anthropic

from .classify import SYSTEM, Classifier
from .sources import PipelineError

API_URL = 'https://api.anthropic.com'
USAGE = {
    'inputTokens': 'input_tokens',
    'cacheReadTokens': 'cache_read_input_tokens',
    'cacheWriteTokens': 'cache_creation_input_tokens',
    'outputTokens': 'output_tokens',
}


def api_error(error):
    if isinstance(error, anthropic.APIStatusError):
        return PipelineError(f'anthropic-api-status-{error.status_code}')
    if isinstance(error, anthropic.APIError):
        return PipelineError('anthropic-api-unreachable')
    # What is left is a stored sign-in that could not be read or renewed.
    return PipelineError('anthropic-api-credential-failed')


class AnthropicClassifier(Classifier):
    """Sends scrubbed comment text to Anthropic.

    The credential is ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN if set, otherwise the sign-in
    stored by `ant auth login`. The pipeline stores none of them.
    """

    review_tokens = 512

    def __init__(self, model, client=None):
        if client is None:
            # The address is fixed so that neither an environment setting nor a sign-in profile
            # can send comment text elsewhere.
            try:
                client = anthropic.Anthropic(base_url=API_URL, max_retries=6)
            except anthropic.AnthropicError as error:
                raise api_error(error) from None
            if client.api_key is None and client.auth_token is None and client.credentials is None:
                raise PipelineError('anthropic-api-credential-missing')
        self.client = client
        self.model = model
        self.usage = Counter()
        self.usage_lock = Lock()

    def params(self, system, prompt, max_tokens):
        return {
            'model': self.model,
            'max_tokens': max_tokens,
            'thinking': {'type': 'disabled'},
            'system': [{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}],
            'messages': [{'role': 'user', 'content': prompt}],
        }

    def read(self, message):
        """The reply text of one message, after adding its token counts to the running totals."""
        with self.usage_lock:
            for name, field in USAGE.items():
                self.usage[name] += getattr(message.usage, field, None) or 0
        return ''.join(block.text for block in message.content if block.type == 'text')

    def request(self, system, prompt, max_tokens):
        try:
            return self.read(self.client.messages.create(**self.params(system, prompt, max_tokens)))
        except anthropic.AnthropicError as error:
            raise api_error(error) from None

    def submit(self, prompts):
        """Send review prompts, given as (custom_id, prompt), as one batch. Returns the batch ID."""
        requests = [
            {'custom_id': custom_id, 'params': self.params(SYSTEM, prompt, self.review_tokens)}
            for custom_id, prompt in prompts
        ]
        try:
            return self.client.messages.batches.create(requests=requests).id
        except anthropic.AnthropicError as error:
            raise api_error(error) from None

    def ended(self, batch_id):
        try:
            return self.client.messages.batches.retrieve(batch_id).processing_status == 'ended'
        except anthropic.AnthropicError as error:
            raise api_error(error) from None

    def results(self, batch_id):
        """Yield (custom_id, reply) for each request of an ended batch that was answered or refused.

        The reply is None when the request ended in an error. Requests that expired or were
        cancelled are left out, so their comments stay queued.
        """
        try:
            for entry in self.client.messages.batches.results(batch_id):
                if entry.result.type == 'succeeded':
                    yield entry.custom_id, self.read(entry.result.message)
                elif entry.result.type == 'errored':
                    yield entry.custom_id, None
        except anthropic.AnthropicError as error:
            raise api_error(error) from None
