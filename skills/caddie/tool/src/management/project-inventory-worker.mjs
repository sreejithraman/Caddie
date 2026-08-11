import { inspectProjectSkillInventoryInProcess } from './inventory.mjs';

const input = JSON.parse(process.argv[2]);

try {
  const result = await inspectProjectSkillInventoryInProcess(input.home, [input.projectRoot], {
    [input.projectRoot]: input.checkout,
  });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'source-unavailable',
      message: typeof error?.message === 'string' ? error.message : 'Project folder could not be inspected',
    },
  }));
}
