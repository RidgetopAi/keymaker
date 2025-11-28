
import { OllamaClient, defaultOllamaConfig } from '../src/services/extraction/ollama-client';
import { performance } from 'perf_hooks';

async function runBenchmark() {
  console.log('Using Config:', JSON.stringify(defaultOllamaConfig, null, 2));
  const ollama = new OllamaClient(defaultOllamaConfig);
  
  console.log('1. Checking Health...');
  const health = await ollama.healthCheck();
  if (!health.healthy) {
    console.error('Ollama is not running!');
    process.exit(1);
  }
  console.log('   Models available:', health.models.join(', '));

  console.log('\n2. Warming up...');
  await ollama.generate('Hello', { max_tokens: 5 });

  console.log('\n3. Running Large Context Benchmark (Prompt Eval)...');
  const largeContext = "The quick brown fox jumps over the lazy dog. ".repeat(500); // ~4500 chars, ~1000 tokens
  const prompt = `${largeContext}\n\nSummarize the above text.`;
  
  console.log(`   Context size: ~${largeContext.length} chars`);
  const start = performance.now();
  const response = await ollama.generate(prompt, { max_tokens: 50 });
  const end = performance.now();
  
  const duration = (end - start) / 1000; 
  console.log(`   Duration: ${duration.toFixed(2)}s`);
  console.log(`   Response: ${response.replace(/\n/g, ' ').substring(0, 100)}...`);

}

runBenchmark().catch(console.error);
