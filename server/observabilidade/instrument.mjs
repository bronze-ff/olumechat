// Entrada ESM para `node --import`. O restante do servidor é CommonJS.
import { createRequire } from 'node:module';

createRequire(import.meta.url)('./instrument.js');
