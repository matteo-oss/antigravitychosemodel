import type { ProviderCapabilities } from './provider-plugin.js';

// Shared configuration metadata; credentials are never stored in the catalog.
export interface ProviderDef {
  id: string;
  name: string;
  envKey: string;
  baseUrl: string;
  adapterType: 'openai' | 'anthropic' | 'google';
  capabilities?: Partial<ProviderCapabilities>;
  baseUrlEnv: string;
  apiKeyAliases?: string[];
}

const DEFINITIONS: Omit<ProviderDef, 'baseUrlEnv'>[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    adapterType: 'openai',
    capabilities: { supportsReasoning: true, supportsImages: true, supportsSystemMessages: true },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    adapterType: 'anthropic',
    capabilities: { supportsReasoning: true, supportsImages: true, supportsSystemMessages: true },
  },
  {
    id: 'google',
    name: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com',
    adapterType: 'google',
    capabilities: { supportsReasoning: false, supportsImages: true, supportsSystemMessages: true },
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    envKey: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    adapterType: 'openai',
    capabilities: { supportsReasoning: true, supportsImages: true },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    adapterType: 'openai',
    capabilities: { supportsReasoning: true, supportsImages: true },
  },
  {
    id: 'groq',
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    adapterType: 'openai',
    capabilities: { supportsReasoning: false, supportsImages: false },
  },
  {
    id: 'zen',
    name: 'Zen (OpenCode)',
    envKey: 'OPENCODE_API_KEY',
    baseUrl: 'https://opencode.ai/zen/v1',
    adapterType: 'openai',
    capabilities: { supportsReasoning: true, supportsImages: false },
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    envKey: 'OPENCODE_GO_API_KEY',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    adapterType: 'openai',
    capabilities: { supportsReasoning: true, supportsImages: false },
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    envKey: '',
    baseUrl: 'http://localhost:11434',
    adapterType: 'openai',
    capabilities: { supportsReasoning: false, supportsImages: true },
  },
  {
    id: 'vllm',
    name: 'vLLM (Local)',
    envKey: '',
    baseUrl: 'http://localhost:8000',
    adapterType: 'openai',
    capabilities: { supportsReasoning: false, supportsImages: true },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    envKey: '',
    baseUrl: 'http://localhost:1234',
    adapterType: 'openai',
    capabilities: { supportsReasoning: false, supportsImages: true },
  },
  {
    id: 'together',
    name: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    baseUrl: 'https://api.together.ai/v1',
    adapterType: 'openai',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Inference Providers',
    envKey: 'HUGGINGFACE_API_KEY',
    baseUrl: 'https://router.huggingface.co/v1',
    adapterType: 'openai',
    apiKeyAliases: ['HF_TOKEN'],
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    envKey: 'SAMBANOVA_API_KEY',
    baseUrl: 'https://api.sambanova.ai/v1',
    adapterType: 'openai',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    envKey: 'SILICONFLOW_API_KEY',
    baseUrl: 'https://api.siliconflow.com/v1',
    adapterType: 'openai',
  },
  {
    id: 'novita',
    name: 'Novita AI',
    envKey: 'NOVITA_API_KEY',
    baseUrl: 'https://api.novita.ai/openai/v1',
    adapterType: 'openai',
  },
  {
    id: 'dashscope',
    name: 'Alibaba Cloud Model Studio (International)',
    envKey: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    adapterType: 'openai',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    adapterType: 'openai',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    envKey: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    adapterType: 'openai',
  },
  { id: 'xai', name: 'xAI', envKey: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1', adapterType: 'openai' },
  {
    id: 'cerebras',
    name: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    adapterType: 'openai',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    adapterType: 'openai',
  },
];

export const BUILTIN_PROVIDERS: ProviderDef[] = DEFINITIONS.map((def) => ({
  ...def,
  baseUrlEnv: (def.id === 'zen' ? 'OPENCODE' : def.id.toUpperCase().replace(/-/g, '_')) + '_BASE_URL',
}));

export function getProviderDefinition(id: string): ProviderDef | undefined {
  return BUILTIN_PROVIDERS.find((def) => def.id === id);
}

export function getProviderApiKey(def: ProviderDef, env: NodeJS.ProcessEnv = process.env): string {
  for (const key of [def.envKey, ...(def.apiKeyAliases || [])]) if (key && env[key]) return env[key]!;
  return '';
}
