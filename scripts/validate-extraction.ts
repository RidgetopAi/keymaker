/**
 * Keymaker Extraction Validation Script
 *
 * Tests the core hypothesis: Can Llama 3.2 3B reliably extract
 * entities, events, and beliefs from natural language observations?
 *
 * Run with: npx tsx scripts/validate-extraction.ts
 * Requires: Ollama installed with llama3.2:3b model
 */

// Test observations - realistic examples of what Brian might input
const testObservations = [
  {
    id: 1,
    text: "Had coffee with Sarah at Blue Bottle yesterday. She's concerned about the Q1 pivot - thinks we're moving too fast without enough customer validation.",
    expected: {
      people: ["Sarah"],
      places: ["Blue Bottle"],
      topics: ["Q1 pivot", "customer validation"],
      events: ["meeting/coffee"],
      beliefs: ["moving too fast concern"]
    }
  },
  {
    id: 2,
    text: "Mom called today. Dad's not doing well - she wants me to visit this weekend. I should go, haven't seen them in two months.",
    expected: {
      people: ["Mom", "Dad"],
      commitments: ["visit this weekend"],
      events: ["phone call"],
      beliefs: ["should visit", "two months since last visit"]
    }
  },
  {
    id: 3,
    text: "Turned down the consulting gig from Marcus. $15k isn't worth three weeks away from the product during launch. This aligns with my focus on shipping over services.",
    expected: {
      people: ["Marcus"],
      decisions: ["turned down consulting"],
      beliefs: ["focus on shipping over services", "launch timing important"],
      events: ["decision made"]
    }
  },
  {
    id: 4,
    text: "Overheard that Jordan might be leaving. If true, we lose our only DevOps person. Need to talk to them directly and maybe accelerate the infrastructure documentation.",
    expected: {
      people: ["Jordan"],
      concerns: ["Jordan leaving", "DevOps coverage"],
      commitments: ["talk to Jordan", "accelerate documentation"],
      roles: ["Jordan is DevOps"]
    }
  },
  {
    id: 5,
    text: "Noticed I've been avoiding the budget review for two weeks. Probably because I already know it shows we're over by 30%. Avoidance is a pattern I should break.",
    expected: {
      topics: ["budget review"],
      patterns: ["avoidance behavior"],
      beliefs: ["budget is 30% over", "avoidance is bad pattern"],
      self_awareness: ["metacognition about avoidance"]
    }
  }
];

// Extraction prompts from Instance #3 design
const ENTITY_PROMPT = `You are an entity extraction system for a personal memory system. Extract structured information from the observation.

Return valid JSON with this structure:
{
  "people": [{"name": "string", "relationship_to_brian": "string or null", "context": "string"}],
  "projects": [{"name": "string", "status": "string or null"}],
  "commitments": [{"description": "string", "due_date": "string or null", "to_whom": "string or null"}],
  "concepts": [{"name": "string", "type": "preference|belief|constraint|goal"}]
}

Only extract what is explicitly mentioned or clearly implied. Do not invent information.

Observation: `;

const EVENT_PROMPT = `You are an event extraction system for a personal memory system. Extract what happened from the observation.

Return valid JSON with this structure:
{
  "events": [{
    "type": "meeting|call|decision|realization|task|other",
    "summary": "string",
    "participants": ["string"],
    "outcome": "string or null",
    "followup_required": boolean,
    "confidence": 0.0-1.0
  }]
}

Observation: `;

const BELIEF_PROMPT = `You are a belief extraction system for a personal memory system. Extract what Brian learned, decided, or believes from this observation.

Return valid JSON with this structure:
{
  "beliefs": [{
    "subject": "string (what this is about)",
    "statement": "string (the belief itself)",
    "type": "fact|preference|constraint|intention|state",
    "confidence": 0.0-1.0,
    "is_temporary": boolean
  }]
}

Extract both explicit statements and implicit beliefs. Include metacognitive observations (beliefs about Brian's own behavior).

Observation: `;

interface ExtractionResult {
  observationId: number;
  promptType: string;
  rawOutput: string;
  parsedOutput: any | null;
  parseError: string | null;
  durationMs: number;
}

async function callOllama(prompt: string, model: string = 'llama3.2:3b'): Promise<{output: string, durationMs: number}> {
  const startTime = Date.now();

  const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,  // Low temperature for consistent extraction
        num_predict: 1000
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    output: data.response,
    durationMs: Date.now() - startTime
  };
}

function tryParseJSON(text: string): { parsed: any | null, error: string | null } {
  // Try to find JSON in the response (LLM might add explanation text)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { parsed: null, error: 'No JSON object found in response' };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return { parsed, error: null };
  } catch (e) {
    return { parsed: null, error: `JSON parse error: ${e}` };
  }
}

async function runExtraction(observation: typeof testObservations[0]): Promise<ExtractionResult[]> {
  const results: ExtractionResult[] = [];

  const prompts = [
    { type: 'entity', prompt: ENTITY_PROMPT },
    { type: 'event', prompt: EVENT_PROMPT },
    { type: 'belief', prompt: BELIEF_PROMPT }
  ];

  for (const { type, prompt } of prompts) {
    console.log(`  Testing ${type} extraction...`);

    try {
      const { output, durationMs } = await callOllama(prompt + observation.text);
      const { parsed, error } = tryParseJSON(output);

      results.push({
        observationId: observation.id,
        promptType: type,
        rawOutput: output,
        parsedOutput: parsed,
        parseError: error,
        durationMs
      });
    } catch (e) {
      results.push({
        observationId: observation.id,
        promptType: type,
        rawOutput: '',
        parsedOutput: null,
        parseError: `Ollama call failed: ${e}`,
        durationMs: 0
      });
    }
  }

  return results;
}

function analyzeResults(allResults: ExtractionResult[]): void {
  console.log('\n' + '='.repeat(60));
  console.log('VALIDATION RESULTS');
  console.log('='.repeat(60) + '\n');

  // JSON parse success rate
  const totalExtractions = allResults.length;
  const successfulParses = allResults.filter(r => r.parsedOutput !== null).length;
  const parseSuccessRate = (successfulParses / totalExtractions * 100).toFixed(1);

  console.log(`JSON Parse Success: ${successfulParses}/${totalExtractions} (${parseSuccessRate}%)`);

  // Average duration
  const avgDuration = allResults.reduce((sum, r) => sum + r.durationMs, 0) / totalExtractions;
  console.log(`Average Extraction Time: ${avgDuration.toFixed(0)}ms`);

  // Group by prompt type
  const byType = new Map<string, ExtractionResult[]>();
  for (const result of allResults) {
    const existing = byType.get(result.promptType) || [];
    existing.push(result);
    byType.set(result.promptType, existing);
  }

  console.log('\nBy Extraction Type:');
  for (const [type, results] of byType) {
    const successes = results.filter(r => r.parsedOutput !== null).length;
    console.log(`  ${type}: ${successes}/${results.length} successful parses`);
  }

  // Show parse errors
  const parseErrors = allResults.filter(r => r.parseError !== null);
  if (parseErrors.length > 0) {
    console.log('\nParse Errors:');
    for (const error of parseErrors) {
      console.log(`  Observation ${error.observationId} (${error.promptType}): ${error.parseError}`);
    }
  }

  // Show sample outputs
  console.log('\nSample Outputs:');
  for (const result of allResults.slice(0, 3)) {
    if (result.parsedOutput) {
      console.log(`\n  Observation ${result.observationId} - ${result.promptType}:`);
      console.log('  ' + JSON.stringify(result.parsedOutput, null, 2).split('\n').join('\n  '));
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('ASSESSMENT');
  console.log('='.repeat(60) + '\n');

  if (parseSuccessRate === '100.0') {
    console.log('✅ All extractions returned valid JSON - core hypothesis supported');
  } else if (parseFloat(parseSuccessRate) >= 80) {
    console.log('⚠️  Most extractions work but some failures - may need prompt tuning');
  } else {
    console.log('❌ High failure rate - extraction approach needs rethinking');
  }

  console.log('\nManual review needed to assess:');
  console.log('  - Entity recall (did we find all people/projects?)');
  console.log('  - Precision (did we avoid hallucinations?)');
  console.log('  - Belief quality (are extracted beliefs meaningful?)');
  console.log('  - Confidence calibration (are scores reasonable?)');
}

async function main() {
  console.log('Keymaker Extraction Validation');
  console.log('==============================\n');

  // Check Ollama availability
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (!response.ok) {
      throw new Error('Ollama not responding');
    }
    const data = await response.json();
    const hasModel = data.models?.some((m: any) => m.name.includes('llama3.2'));
    if (!hasModel) {
      console.error('❌ llama3.2 model not found. Run: ollama pull llama3.2:3b');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Cannot connect to Ollama at localhost:11434');
    console.error('   Make sure Ollama is installed and running');
    console.error('   Installation: https://ollama.ai');
    process.exit(1);
  }

  console.log('✅ Ollama connected, llama3.2 model available\n');

  const allResults: ExtractionResult[] = [];

  for (const observation of testObservations) {
    console.log(`\nObservation ${observation.id}:`);
    console.log(`  "${observation.text.substring(0, 60)}..."`);

    const results = await runExtraction(observation);
    allResults.push(...results);
  }

  analyzeResults(allResults);
}

main().catch(console.error);
