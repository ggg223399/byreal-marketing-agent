import { spawn } from 'child_process';

interface CallClaudeTextOptions {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

function normalizeModelForClaudeCli(model: string): string {
  const value = model.toLowerCase();
  if (value.includes('haiku')) return 'haiku';
  if (value.includes('sonnet')) return 'sonnet';
  if (value.includes('opus')) return 'opus';
  return model;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('CLI output did not contain JSON');
  }

  return trimmed.slice(start, end + 1);
}

async function callViaClaudeCli(opts: CallClaudeTextOptions): Promise<string> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required for Claude CLI mode');
  }

  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', normalizeModelForClaudeCli(opts.model),
      '--system-prompt', opts.systemPrompt,
    ];

    const child = spawn('claude', args, {
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
      },
      timeout: 120000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.stdin.write(opts.userPrompt);
    child.stdin.end();

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      try {
        const payload = JSON.parse(extractJsonObject(stdout)) as {
          is_error?: boolean;
          result?: unknown;
        };

        if (payload.is_error) {
          reject(new Error(typeof payload.result === 'string' ? payload.result : 'Claude CLI call failed'));
          return;
        }
        if (typeof payload.result !== 'string' || !payload.result.trim()) {
          reject(new Error('Claude CLI returned empty text result'));
          return;
        }

        resolve(payload.result.trim());
      } catch (err) {
        reject(new Error(`Failed to parse Claude CLI output: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}

async function callViaAnthropicApi(opts: CallClaudeTextOptions): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for direct API mode');
  }

  const sdk = await import('@anthropic-ai/sdk');
  const client = new sdk.default({ apiKey });

  const response = await client.messages.create({
    model: opts.model,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    system: opts.systemPrompt,
    messages: [{ role: 'user', content: opts.userPrompt }],
  });

  const text = (response.content ?? [])
    .map((block: { type: string; text?: string }) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Empty response from Anthropic API');
  }

  return text;
}

export async function callClaudeText(opts: CallClaudeTextOptions): Promise<string> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return callViaClaudeCli(opts);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return callViaAnthropicApi(opts);
  }
  throw new Error('Missing Claude credentials. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY');
}
