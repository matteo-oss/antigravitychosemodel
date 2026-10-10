import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapContentsToMessages, mapTools, mapGenerationConfig } from '../src/mapper.js';

describe('mapContentsToMessages', () => {
  it('should convert Gemini user message to OpenAI format', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'Hello' }] }
    ];

    const result = mapContentsToMessages(contents);

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'Hello');
  });

  it('should convert model role to assistant', () => {
    const contents = [
      { role: 'model', parts: [{ text: 'Hi there' }] }
    ];

    const result = mapContentsToMessages(contents);

    assert.equal(result.messages[0].role, 'assistant');
  });

  it('should convert functionCall to tool_calls', () => {
    const contents = [
      {
        role: 'model',
        parts: [{
          functionCall: { name: 'view_file', args: '{"path": "test.txt"}' }
        }]
      }
    ];

    const result = mapContentsToMessages(contents);

    assert.equal(result.messages[0].role, 'assistant');
    assert.ok(result.messages[0].tool_calls);
    assert.equal(result.messages[0].tool_calls![0].function.name, 'view_file');
  });

  it('should convert functionResponse to tool message', () => {
    const contents = [
      {
        role: 'user',
        parts: [{
          functionResponse: { name: 'view_file', response: { content: 'file content' } }
        }]
      }
    ];

    const result = mapContentsToMessages(contents);

    assert.equal(result.messages[0].role, 'tool');
    assert.equal(result.messages[0].content, '{"content":"file content"}');
  });

  it('preserves validation feedback beside a file-tool response', () => {
    const error = "Error invalid tool call: invalid arguments: additional properties 'AbsolutePath' not allowed";
    const result = mapContentsToMessages([
      {
        role: 'model',
        parts: [{ functionCall: { name: 'write_to_file', args: '{"AbsolutePath":"/tmp/test.txt"}' } }],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'write_to_file', response: '{}' } },
          { text: error },
        ],
      },
    ]);

    assert.deepEqual(result.messages.slice(1), [
      { role: 'tool', tool_call_id: 'call_write_to_file_0', content: '{}' },
      { role: 'user', content: error },
    ]);
  });

  it('keeps all tool responses together before sibling feedback', () => {
    const result = mapContentsToMessages([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'write_to_file', args: '{}' } },
          { functionCall: { name: 'view_file', args: '{}' } },
        ],
      },
      {
        role: 'user',
        parts: [
          { text: 'The write operation failed. Retry with TargetFile.' },
          { functionResponse: { name: 'write_to_file', response: '{}' } },
          { functionResponse: { name: 'view_file', response: '{"content":"existing file"}' } },
        ],
      },
    ]);

    assert.deepEqual(result.messages.slice(1), [
      { role: 'tool', tool_call_id: 'call_write_to_file_0', content: '{}' },
      { role: 'tool', tool_call_id: 'call_view_file_1', content: '{"content":"existing file"}' },
      { role: 'user', content: 'The write operation failed. Retry with TargetFile.' },
    ]);
  });

  it('preserves sibling error text in SDK tool-result content', () => {
    const result = mapContentsToMessages([
      {
        role: 'model',
        content: [{ type: 'tool-call', toolName: 'write_to_file', args: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolName: 'write_to_file', result: { success: false } },
          { type: 'text', text: 'Invalid arguments: TargetFile is required.' },
        ],
      },
    ]);

    assert.deepEqual(result.messages.slice(1), [
      { role: 'tool', tool_call_id: 'call_write_to_file_0', content: '{"success":false}' },
      { role: 'user', content: 'Invalid arguments: TargetFile is required.' },
    ]);
  });

  it('defers feedback until consecutive parallel tool-response messages finish', () => {
    const result = mapContentsToMessages([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'write_to_file', args: '{}' } },
          { functionCall: { name: 'view_file', args: '{}' } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'write_to_file', response: '{}' } },
          { text: 'Write failed: TargetFile is required.' },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'view_file', response: '{"content":"existing file"}' } },
          { text: 'The existing file was read successfully.' },
        ],
      },
      { role: 'user', content: 'Try writing again.' },
    ]);

    assert.deepEqual(result.messages.slice(1), [
      { role: 'tool', tool_call_id: 'call_write_to_file_0', content: '{}' },
      { role: 'tool', tool_call_id: 'call_view_file_1', content: '{"content":"existing file"}' },
      { role: 'user', content: 'Write failed: TargetFile is required.' },
      { role: 'user', content: 'The existing file was read successfully.' },
      { role: 'user', content: 'Try writing again.' },
    ]);
  });

  it('should handle thought parts', () => {
    const contents = [
      {
        role: 'model',
        parts: [
          { thought: true, text: 'thinking...' },
          { text: 'response' }
        ]
      }
    ];

    const result = mapContentsToMessages(contents);

    assert.equal(result.messages[0].reasoning_content, 'thinking...');
    assert.equal(result.messages[0].content, 'response');
  });

  it('should set system instruction', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'Hello' }] }
    ];

    const result = mapContentsToMessages(contents, 'You are a helpful assistant');

    assert.equal(result.system, 'You are a helpful assistant');
  });

  it('should handle empty parts with string content', () => {
    const contents = [
      { role: 'user', content: 'Hello' }
    ];

    const result = mapContentsToMessages(contents);

    assert.equal(result.messages[0].content, 'Hello');
  });
});

describe('mapTools', () => {
  it('should convert Gemini tools to OpenAI format', () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'view_file',
            description: 'View file contents',
            parameters: {
              type: 'object',
              properties: {
                AbsolutePath: { type: 'string' }
              },
              required: ['AbsolutePath']
            }
          }
        ]
      }
    ];

    const result = mapTools(tools);

    assert.ok(result);
    assert.ok(result!['view_file']);
    assert.equal(result!['view_file'].description, 'View file contents');
  });

  it('prefers the current parametersJsonSchema over legacy parameters', () => {
    const schema = {
      type: 'object',
      properties: { TargetFile: { type: 'string' }, CodeContent: { type: 'string' } },
      required: ['TargetFile', 'CodeContent'],
      additionalProperties: false,
    };
    const tools = [{
      functionDeclarations: [{
        name: 'write_to_file',
        description: 'Write a file',
        parameters: { type: 'object', properties: { AbsolutePath: { type: 'string' } } },
        parametersJsonSchema: schema,
      }],
    }];

    assert.deepEqual(mapTools(tools)!.write_to_file.parameters, schema);
  });

  it('supports tools declared only with parametersJsonSchema', () => {
    const schema = {
      type: 'object',
      properties: { TargetFile: { type: 'string' } },
      required: ['TargetFile'],
      additionalProperties: false,
    };
    const tools = [{
      functionDeclarations: [{ name: 'write_to_file', description: 'Write a file', parametersJsonSchema: schema }],
    }];

    assert.deepEqual(mapTools(tools as any)!.write_to_file.parameters, schema);
  });

  it('retains nested schema constraints that reject invalid file arguments', () => {
    const schema = {
      type: 'object',
      properties: {
        TargetFile: { type: 'string', minLength: 1, pattern: '^/' },
        CodeContent: { type: 'string', maxLength: 100000 },
        Options: {
          type: 'object',
          properties: { Overwrite: { type: 'boolean', default: false } },
          additionalProperties: false,
        },
      },
      required: ['TargetFile', 'CodeContent'],
      additionalProperties: false,
      oneOf: [{ required: ['Options'] }, { not: { required: ['Options'] } }],
    };
    const tools = [{ functionDeclarations: [{ name: 'write_to_file', description: 'Write', parameters: schema }] }];

    assert.deepEqual(mapTools(tools)!.write_to_file.parameters, schema);
  });

  it('retains refs, enum-only and boolean schemas without adding an object type', () => {
    const schema = {
      type: 'object',
      $defs: { filePath: { type: 'string', minLength: 1 } },
      properties: {
        TargetFile: { $ref: '#/$defs/filePath' },
        Mode: { enum: ['create', 'overwrite'] },
        Forbidden: false,
      },
      additionalProperties: false,
    };
    const tools = [{ functionDeclarations: [{ name: 'write_to_file', description: 'Write', parameters: schema }] }];

    assert.deepEqual(mapTools(tools as any)!.write_to_file.parameters, schema);
  });

  it('normalizes Gemini types while preserving literal data and the input schema', () => {
    const schema = {
      type: 'OBJECT',
      properties: {
        TargetFile: { type: 'STRING', minLength: 1 },
        Settings: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: { type: { type: 'STRING', const: 'STRING' } } },
          default: [{ type: 'STRING' }],
        },
        Fallback: { anyOf: [{ type: 'STRING' }, { type: 'NULL' }] },
        Optional: { type: ['STRING', 'NULL'] },
      },
      additionalProperties: false,
    };
    const original = structuredClone(schema);
    const expected = structuredClone(schema);
    expected.type = 'object';
    expected.properties.TargetFile.type = 'string';
    expected.properties.Settings.type = 'array';
    expected.properties.Settings.items.type = 'object';
    expected.properties.Settings.items.properties.type.type = 'string';
    expected.properties.Fallback.anyOf[0].type = 'string';
    expected.properties.Fallback.anyOf[1].type = 'null';
    expected.properties.Optional.type = ['string', 'null'];
    const tools = [{ functionDeclarations: [{ name: 'write_to_file', description: 'Write', parameters: schema }] }];

    assert.deepEqual(mapTools(tools)!.write_to_file.parameters, expected);
    assert.deepEqual(schema, original);
  });

  it('should return undefined for empty tools', () => {
    const result = mapTools([]);
    assert.equal(result, undefined);
  });

  it('should return undefined for undefined tools', () => {
    const result = mapTools(undefined);
    assert.equal(result, undefined);
  });
});

describe('mapGenerationConfig', () => {
  it('should map maxOutputTokens to maxTokens', () => {
    const config = { maxOutputTokens: 1000 };

    const result = mapGenerationConfig(config);

    assert.equal(result.maxTokens, 1000);
  });

  it('should map temperature', () => {
    const config = { temperature: 0.7 };

    const result = mapGenerationConfig(config);

    assert.equal(result.temperature, 0.7);
  });

  it('should map topP', () => {
    const config = { topP: 0.9 };

    const result = mapGenerationConfig(config);

    assert.equal(result.topP, 0.9);
  });

  it('should map stopSequences', () => {
    const config = { stopSequences: ['END', 'STOP'] };

    const result = mapGenerationConfig(config);

    assert.deepEqual(result.stopSequences, ['END', 'STOP']);
  });

  it('should handle empty config', () => {
    const result = mapGenerationConfig({});

    assert.equal(result.maxTokens, undefined);
    assert.equal(result.temperature, undefined);
  });
});
