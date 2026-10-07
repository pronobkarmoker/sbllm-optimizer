import 'dotenv/config';
import { buildCliProvider } from './provider.js';

async function main() {
  const { provider, label } = buildCliProvider();

  console.log(`[smoke-test] calling ${label}...`);
  const response = await provider.generate({
    system: 'You are a terse assistant. Reply in one short sentence.',
    user: 'Say hello and confirm you can see this working end to end.',
  });

  console.log('[smoke-test] response:');
  console.log(response.text);
}

main().catch((err) => {
  console.error('[smoke-test] failed:', err);
  process.exit(1);
});
