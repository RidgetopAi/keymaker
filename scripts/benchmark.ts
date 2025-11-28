#!/usr/bin/env npx tsx

import { Pool } from 'pg';

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'keymaker_dev',
});

// Ollama configuration
const OLLAMA_URL = 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';

async function embed(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });

  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.embedding;
}

async function addObservation(text: string): Promise<void> {
  const embedding = await embed(text);
  const embeddingStr = `[${embedding.join(',')}]`;

  await pool.query(
    `INSERT INTO observations (content, embedding)
     VALUES ($1, $2::vector)`,
    [text, embeddingStr]
  );
}

async function queryPerformance(question: string, limit: number = 5): Promise<number> {
  const startTime = Date.now();

  const embedding = await embed(question);
  const embeddingStr = `[${embedding.join(',')}]`;

  // Find similar observations
  await pool.query(
    `SELECT content, 1 - (embedding <=> $1::vector) as similarity, created_at
     FROM observations
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [embeddingStr, limit]
  );

  return Date.now() - startTime;
}

async function benchmark() {
  console.log('=== Keymaker Performance Benchmark ===\n');

  // Count current observations
  const countResult = await pool.query('SELECT COUNT(*) as count FROM observations');
  const currentCount = parseInt(countResult.rows[0].count);
  console.log(`Starting with ${currentCount} observations\n`);

  // Test queries at current scale
  console.log('Query performance at current scale:');
  const queries = [
    'Who is Sarah?',
    'What are my commitments?',
    'What decisions have been made?',
    'What am I stressed about?',
    'Tell me about the project'
  ];

  let totalTime = 0;
  for (const query of queries) {
    const time = await queryPerformance(query);
    console.log(`  "${query}": ${time}ms`);
    totalTime += time;
  }
  console.log(`Average query time: ${Math.round(totalTime / queries.length)}ms\n`);

  // Add synthetic observations for scale testing
  console.log('Adding 50 synthetic observations for scale testing...');
  const topics = ['meeting', 'decision', 'commitment', 'reflection', 'technical'];
  const people = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'];

  for (let i = 0; i < 50; i++) {
    const topic = topics[i % topics.length];
    const person = people[i % people.length];
    const observation = `${topic} ${i}: Had a discussion with ${person} about project aspect ${i}. This relates to our ongoing work on feature ${i % 10}.`;
    await addObservation(observation);

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  Added ${i + 1}/50\r`);
    }
  }
  console.log('  Added 50/50    \n');

  // Test queries at new scale
  const newCountResult = await pool.query('SELECT COUNT(*) as count FROM observations');
  const newCount = parseInt(newCountResult.rows[0].count);
  console.log(`Now have ${newCount} observations\n`);

  console.log('Query performance at new scale:');
  totalTime = 0;
  for (const query of queries) {
    const time = await queryPerformance(query);
    console.log(`  "${query}": ${time}ms`);
    totalTime += time;
  }
  console.log(`Average query time: ${Math.round(totalTime / queries.length)}ms\n`);

  // Test with higher retrieval counts
  console.log('Testing retrieval count impact:');
  const testQuery = 'Tell me about the project';
  for (const limit of [5, 10, 20, 50]) {
    const time = await queryPerformance(testQuery, limit);
    console.log(`  Top ${limit} results: ${time}ms`);
  }

  // Storage statistics
  console.log('\nStorage statistics:');
  const sizeResult = await pool.query(`
    SELECT
      pg_size_pretty(pg_total_relation_size('observations')) as table_size
  `);
  console.log(`  Table size: ${sizeResult.rows[0].table_size}`);

  // Check for indexes
  const indexResult = await pool.query(`
    SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) as size
    FROM pg_indexes
    WHERE tablename = 'observations'
  `);

  if (indexResult.rows.length > 0) {
    console.log('  Indexes:');
    for (const idx of indexResult.rows) {
      console.log(`    ${idx.indexname}: ${idx.size}`);
    }
  } else {
    console.log('  No indexes found');
  }

  // Memory usage estimate
  const avgObsLength = await pool.query(`
    SELECT AVG(LENGTH(content)) as avg_length FROM observations
  `);
  console.log(`  Average observation length: ${Math.round(avgObsLength.rows[0].avg_length)} chars`);
  console.log(`  Embedding dimensions: 768`);
  console.log(`  Storage per observation: ~${Math.round(768 * 4 + avgObsLength.rows[0].avg_length)} bytes`);
}

async function main() {
  try {
    await benchmark();
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();