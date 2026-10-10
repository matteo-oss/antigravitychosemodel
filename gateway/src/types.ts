export interface Content {
  parts?: Part[];
  content?: any;
  role: string;
}

export interface Part {
  text?: string;
  type?: string;
  thought?: boolean;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  inlineData?: { mimeType: string; data: string };
  image?: string;
  image_url?: { url: string };
  fileData?: { fileUri: string; mimeType: string };
}

export interface FunctionCall {
  name: string;
  args: Buffer | string;
}

export interface FunctionResponse {
  name: string;
  response: Buffer | string;
}

export interface Tool {
  functionDeclarations?: FunctionDeclaration[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: Schema | null;
  parametersJsonSchema?: Record<string, unknown> | null;
}

export interface Schema {
  [key: string]: unknown;
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema | boolean>;
  required?: string[];
  items?: Schema | boolean | Array<Schema | boolean>;
  enum?: unknown[];
}

export interface GenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number };
}

export interface ExternalChatMessage {
  role: string;
  parts: ExternalContentPart[];
  toolCallId?: string;
  name?: string;
}

export interface ExternalContentPart {
  text?: string;
  mimeType?: string;
  data?: Buffer;
  functionCall?: { name: string; arguments: Buffer };
  functionResponse?: { name: string; response: Buffer };
}

export interface ExternalFunctionDeclaration {
  name: string;
  description: string;
  parameters: Buffer;
}
