/**
 * Quick test for Groq provider integration
 */
import 'dotenv/config';
import { healthCheck, generate, getConfig } from './src/services/extraction/provider-factory.js';

async function test() {
  console.log('=== LLM Provider Test ===\n');

  const config = getConfig();
  console.log('Provider:', config.provider);
  console.log('Groq Model:', config.groq?.model || 'not configured');
  console.log('');

  // Health check
  console.log('Running health check...');
  const health = await healthCheck();
  console.log(
    'Generation:',
    health.generation.provider,
    '-',
    health.generation.healthy ? '✓ OK' : '✗ FAILED',
    health.generation.info || ''
  );
  console.log(
    'Embedding:',
    health.embedding.provider,
    '-',
    health.embedding.healthy ? '✓ OK' : '✗ FAILED',
    health.embedding.info || ''
  );
  console.log('');

  // Quick generation test
  console.log('Testing generation...');
  const start = Date.now();
  const result = await generate('Say hello in exactly 5 words.');
  const elapsed = Date.now() - start;
  console.log('Response:', result.trim());
  console.log('Time:', elapsed, 'ms');
  console.log('');
  console.log('✓ Groq integration working!');
}

test().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
