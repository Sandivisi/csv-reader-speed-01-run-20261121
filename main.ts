// Driver for the csv-reader-speed entry: reads every case from the input
// directory, answers each one alone with run() from solve.js, and writes the
// answers in order to the output directory. Run by the harness as
// `node /bot/main.ts` (Node 22); outside a container the input and output
// directories can be pointed elsewhere with MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR. V8's incremental marking is switched off before
// solve.js is imported, so all of the parsing runs under that setting.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types). */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
