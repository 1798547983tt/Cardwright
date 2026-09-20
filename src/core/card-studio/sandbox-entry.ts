/**
 * The child process that runs a card's Zod schema. It is spawned with Node's permission model on, reads one
 * request from stdin, answers on stdout and exits. Nothing else in the application is reachable from here.
 */
import { evaluateSchema, validateInitialVariables } from './variables.ts';

interface Request { code: string; value: unknown; timeoutMs?: number }

const chunks: Buffer[] = [];
process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
process.stdin.on('end', () => {
  let answer: Record<string, unknown>;
  try {
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request;
    const evaluated = evaluateSchema(request.code, { timeoutMs: request.timeoutMs });
    const result = validateInitialVariables(evaluated.schema, request.value);
    answer = { ok: result.ok, issues: result.issues, value: result.value, registered: evaluated.registered };
  } catch (error) {
    answer = { ok: false, issues: [], error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(JSON.stringify(answer));
});
